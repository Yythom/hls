// Per-task context that follows a queued task through every `await`, so the
// modules doing the actual work (ffmpeg, HTTP/HLS downloaders, tools) can pick
// up the task's abort signal and progress sink without threading them through
// every function signature.

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

// ctx: { signal: AbortSignal, report(channel, payload) }
function runInTask(ctx, fn) {
  return storage.run(ctx, fn);
}

function currentTask() {
  return storage.getStore() || null;
}

function currentSignal() {
  return storage.getStore()?.signal;
}

// Throw the abort reason if the current task has been canceled; a no-op
// outside a task. Call at loop / retry boundaries.
function throwIfCanceled() {
  currentSignal()?.throwIfAborted();
}

function isCanceled() {
  return !!currentSignal()?.aborted;
}

// Kill `child` when the current task is canceled. `kill` defaults to SIGKILL
// on the child itself; pass one for process trees.
function bindChildToTask(child, kill = () => child.kill("SIGKILL")) {
  const signal = currentSignal();
  if (!signal) return;
  if (signal.aborted) {
    kill();
    return;
  }
  const onAbort = () => kill();
  signal.addEventListener("abort", onAbort, { once: true });
  child.once("close", () => signal.removeEventListener("abort", onAbort));
}

module.exports = { runInTask, currentTask, currentSignal, throwIfCanceled, isCanceled, bindChildToTask };
