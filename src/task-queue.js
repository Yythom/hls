// Global task queue for every long-running job in the app: downloads, yt-dlp,
// transcodes, compression, trimming… Each task kind is a handler (see
// task-handlers.js); the queue owns scheduling, cancel / retry and progress.
//
// Tasks run in lanes with independent concurrency limits, because network
// jobs and CPU-bound ffmpeg encodes compete for different resources: a few
// parallel downloads help, but a second x264 encode only slows both down.
//
// Every change to a task is pushed to the renderer as a `task:update` event
// carrying the task's full public state.

const { runInTask } = require("./task-context");

const PROGRESS_THROTTLE_MS = 250;
const LANE_LIMIT_MAX = 6;
// Finished tasks stay listed until cleared; past this many the oldest go.
const MAX_FINISHED = 200;
const ACTIVE_STATES = new Set(["queued", "running"]);

function createTaskQueue({ handlers, journal, send, logEvent, limits: initialLimits }) {
  const tasks = new Map(); // id -> task, in insertion order
  const limits = { network: 3, cpu: 1, ...initialLimits };
  let seq = 0;

  function publicTask(task) {
    const { job, controller, lastEmit, running, ...rest } = task;
    return rest;
  }

  function emit(task) {
    task.lastEmit = Date.now();
    send("task:update", { type: "update", task: publicTask(task) });
  }

  function pump() {
    const running = {};
    for (const t of tasks.values()) {
      if (t.state === "running") running[t.lane] = (running[t.lane] || 0) + 1;
    }
    for (const task of tasks.values()) {
      if (task.state !== "queued") continue;
      if ((running[task.lane] || 0) >= (limits[task.lane] || 1)) continue;
      running[task.lane] = (running[task.lane] || 0) + 1;
      task.running = start(task);
    }
  }

  async function start(task) {
    const handler = handlers[task.kind];
    const controller = new AbortController();
    Object.assign(task, {
      state: "running",
      phase: "",
      percent: null,
      text: "启动中…",
      error: "",
      controller,
      startedAt: Date.now(),
    });
    emit(task);

    // Progress is throttled, except that a phase change always goes out.
    const update = (patch) => {
      if (task.state !== "running" || !patch) return;
      const phaseChanged = patch.phase !== undefined && patch.phase !== task.phase;
      Object.assign(task, patch);
      if (phaseChanged || Date.now() - task.lastEmit >= PROGRESS_THROTTLE_MS) emit(task);
    };
    const ctx = {
      id: task.id,
      signal: controller.signal,
      update,
      // Progress events the worker modules `send()` while inside this task.
      report: (channel, payload) => update(handler.mapProgress?.(channel, payload)),
      // Record scratch this run leaves behind if the app dies mid-way.
      track: (item) => journal.track(task.id, item),
    };

    try {
      const result = await runInTask(ctx, () => handler.run(task.job, ctx));
      if (task.state === "running") {
        Object.assign(task, {
          state: "done",
          percent: 100,
          text: "",
          filePath: result?.filePath || "",
          size: result?.size || 0,
          summary: result?.summary || "",
        });
      }
    } catch (error) {
      // cancel() already set the state; don't turn it into a failure.
      if (task.state === "running") {
        task.state = "error";
        task.error = error?.message || String(error);
        logEvent("error", "Task failed", { kind: task.kind, title: task.title, error: task.error });
      }
    } finally {
      // run() has cleaned up after itself by now, whatever the outcome.
      journal.release(task.id);
      task.controller = null;
      task.running = null;
      task.finishedAt = Date.now();
      if (tasks.has(task.id)) emit(task);
      pruneFinished();
      pump();
    }
  }

  function pruneFinished() {
    const finished = [...tasks.values()].filter((t) => !ACTIVE_STATES.has(t.state) && !t.controller);
    for (const task of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) remove(task.id);
  }

  // entries: [{ kind, job }]. All-or-nothing: an invalid entry or an output
  // path another active task already writes to rejects the whole batch.
  function add(entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    const claimed = new Set();
    for (const t of tasks.values()) {
      if (ACTIVE_STATES.has(t.state) && t.output) claimed.add(t.output);
    }

    const prepared = list.map(({ kind, job }) => {
      const handler = handlers[kind];
      if (!handler) throw new Error(`未知任务类型：${kind}`);
      const { title, output = "" } = handler.describe(job || {});
      if (output) {
        if (claimed.has(output)) throw new Error(`已有任务正在写入该文件：${output}`);
        claimed.add(output);
      }
      return { kind, job, handler, title, output };
    });

    const ids = prepared.map(({ kind, job, handler, title, output }) => {
      const id = `task-${Date.now()}-${++seq}`;
      const task = {
        id,
        kind,
        lane: handler.lane,
        title,
        output,
        state: "queued",
        phase: "",
        percent: null,
        text: "",
        error: "",
        filePath: "",
        size: 0,
        summary: "",
        createdAt: Date.now(),
        job,
        controller: null,
        lastEmit: 0,
      };
      tasks.set(id, task);
      emit(task);
      return id;
    });
    logEvent("info", "Tasks queued", { count: ids.length, kinds: [...new Set(list.map((e) => e.kind))] });
    pump();
    return { ok: true, ids };
  }

  function cancel(id) {
    const task = tasks.get(id);
    if (!task || !ACTIVE_STATES.has(task.state)) return { ok: false };
    const wasRunning = task.state === "running";
    task.state = "canceled";
    task.text = "";
    emit(task);
    if (wasRunning) task.controller?.abort(new Error("已取消"));
    return { ok: true };
  }

  function cancelAll() {
    for (const id of tasks.keys()) cancel(id);
    return { ok: true };
  }

  function retry(id) {
    const task = tasks.get(id);
    if (!task || (task.state !== "error" && task.state !== "canceled")) return { ok: false };
    // A canceled job still winding down would race its own rerun.
    if (task.controller) return { ok: false, error: "正在停止，请稍后再试" };
    if (task.output) {
      for (const t of tasks.values()) {
        if (t !== task && ACTIVE_STATES.has(t.state) && t.output === task.output) {
          return { ok: false, error: `已有任务正在写入该文件：${task.output}` };
        }
      }
    }
    Object.assign(task, { state: "queued", error: "", percent: null, phase: "", text: "" });
    emit(task);
    pump();
    return { ok: true };
  }

  function remove(id) {
    const task = tasks.get(id);
    if (!task || task.state === "running" || task.state === "queued") return { ok: false };
    tasks.delete(id);
    // e.g. yt-dlp keeps partial downloads of a canceled task for a retry.
    Promise.resolve(handlers[task.kind].cleanup?.(task.id)).catch(() => {});
    send("task:update", { type: "remove", id });
    return { ok: true };
  }

  function clearFinished() {
    for (const task of [...tasks.values()]) remove(task.id);
    return { ok: true };
  }

  function setLimit(lane, n) {
    if (!(lane in limits)) return { ok: false };
    limits[lane] = Math.max(1, Math.min(LANE_LIMIT_MAX, Math.floor(Number(n)) || 1));
    pump();
    return { ok: true, limits: { ...limits } };
  }

  function list() {
    return { tasks: [...tasks.values()].map(publicTask), limits: { ...limits } };
  }

  function activeCount() {
    let n = 0;
    for (const t of tasks.values()) if (ACTIVE_STATES.has(t.state)) n++;
    return n;
  }

  // Cancel everything and wait (bounded) for running jobs to kill their
  // processes and delete their partial files. Whatever misses the deadline is
  // still in the journal and gets swept on next launch.
  async function shutdown(timeoutMs = 5000) {
    cancelAll();
    const pending = [...tasks.values()].map((t) => t.running).filter(Boolean);
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
    await Promise.allSettled(
      Object.values(handlers).map((h) => Promise.resolve(h.cleanupAll?.()))
    );
  }

  return { add, cancel, cancelAll, retry, remove, clearFinished, setLimit, list, activeCount, shutdown };
}

module.exports = { createTaskQueue };
