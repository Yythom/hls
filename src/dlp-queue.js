// Download queue for yt-dlp jobs: runs up to `maxParallel` at once, the rest
// wait in FIFO order. Every change to a task is pushed to the renderer as a
// `dlp:queue` event carrying that task's full public state.

const PROGRESS_THROTTLE_MS = 250;
const MAX_PARALLEL_LIMIT = 6;

function createDlpQueue({ ytdlp, send, logEvent }) {
  const tasks = new Map(); // id -> task, in insertion order
  let maxParallel = 2;
  let seq = 0;

  function publicTask(task) {
    const { signal, lastEmit, job, ...rest } = task;
    return rest;
  }

  function emit(task, force = true) {
    const now = Date.now();
    if (!force && now - task.lastEmit < PROGRESS_THROTTLE_MS) return;
    task.lastEmit = now;
    send("dlp:queue", { type: "update", task: publicTask(task) });
  }

  function runningCount() {
    let n = 0;
    for (const t of tasks.values()) if (t.state === "running") n++;
    return n;
  }

  function pump() {
    for (const task of tasks.values()) {
      if (runningCount() >= maxParallel) return;
      if (task.state === "queued") start(task);
    }
  }

  async function start(task) {
    task.state = "running";
    task.phase = "starting";
    task.percent = 0;
    task.speed = "";
    task.eta = "";
    task.error = "";
    task.signal = {};
    task.startedAt = Date.now();
    emit(task);

    try {
      const result = await ytdlp.runDownload(task.job, {
        signal: task.signal,
        onProgress: (p) => {
          if (task.state !== "running") return;
          task.phase = p.phase;
          if (typeof p.percent === "number") task.percent = p.percent;
          if (p.speed !== undefined) task.speed = p.speed;
          if (p.eta !== undefined) task.eta = p.eta;
          if (p.total !== undefined) task.total = p.total;
          emit(task, p.phase !== "downloading");
        },
      });
      task.state = "done";
      task.percent = 100;
      task.filePath = result.filePath;
      task.size = result.size || 0;
    } catch (error) {
      // cancel() already set the state; don't turn it into a failure.
      if (task.state === "running") {
        task.state = "error";
        task.error = error.message;
      }
    } finally {
      task.signal = null;
      task.finishedAt = Date.now();
      if (tasks.has(task.id)) emit(task);
      pump();
    }
  }

  // jobs: [{ title, url, format, audioFormat, output | outputDir, namePrefix,
  //          playlistItem, cookiesFromBrowser, cookiesFile, userAgent, concurrency }]
  function enqueue(jobs) {
    const list = Array.isArray(jobs) ? jobs : [jobs];
    const ids = [];
    for (const job of list) {
      if (!job?.url || (!job.output && !job.outputDir)) continue;
      const id = `dlp-${Date.now()}-${++seq}`;
      const { title, ...rest } = job;
      const task = {
        id,
        title: title || job.url,
        url: job.url,
        state: "queued",
        phase: "",
        percent: 0,
        speed: "",
        eta: "",
        total: "",
        error: "",
        filePath: "",
        size: 0,
        createdAt: Date.now(),
        job: rest,
        signal: null,
        lastEmit: 0,
      };
      tasks.set(id, task);
      ids.push(id);
      emit(task);
    }
    logEvent("info", "Queued yt-dlp downloads", { count: ids.length });
    pump();
    return { ok: true, ids };
  }

  function cancel(id) {
    const task = tasks.get(id);
    if (!task) return { ok: false };
    if (task.state === "queued") {
      task.state = "canceled";
      emit(task);
    } else if (task.state === "running") {
      task.state = "canceled";
      task.signal?.kill?.();
      emit(task);
    }
    return { ok: true };
  }

  function cancelAll() {
    for (const id of tasks.keys()) cancel(id);
    return { ok: true };
  }

  function retry(id) {
    const task = tasks.get(id);
    if (!task || (task.state !== "error" && task.state !== "canceled")) return { ok: false };
    // A canceled download whose process hasn't exited yet would race its rerun.
    if (task.signal) return { ok: false, error: "正在停止，请稍后再试" };
    task.state = "queued";
    task.error = "";
    task.percent = 0;
    task.phase = "";
    emit(task);
    pump();
    return { ok: true };
  }

  function remove(id) {
    const task = tasks.get(id);
    if (!task || task.state === "running") return { ok: false };
    tasks.delete(id);
    send("dlp:queue", { type: "remove", id });
    return { ok: true };
  }

  function clearFinished() {
    for (const task of [...tasks.values()]) {
      if (task.state === "done" || task.state === "canceled" || task.state === "error") {
        remove(task.id);
      }
    }
    return { ok: true };
  }

  function setParallel(n) {
    const value = Math.max(1, Math.min(MAX_PARALLEL_LIMIT, Math.floor(Number(n)) || 1));
    maxParallel = value;
    pump();
    return { ok: true, maxParallel };
  }

  function list() {
    return { tasks: [...tasks.values()].map(publicTask), maxParallel };
  }

  return { enqueue, cancel, cancelAll, retry, remove, clearFinished, setParallel, list };
}

module.exports = { createDlpQueue };
