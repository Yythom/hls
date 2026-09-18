// A small on-disk record of what running tasks leave behind if the app dies
// mid-way (crash, force quit, power loss): partial output files and scratch
// directories, plus a marker string that appears in the command line of every
// process the task spawned. On the next launch `sweep()` kills any process
// still carrying a marker (an orphaned ffmpeg / yt-dlp keeps running after its
// parent dies) and deletes the leftovers.
//
// Entries only ever name scratch paths (`*.vfpart-<task>*`, per-task temp
// dirs), never a finished output, so sweeping can't destroy a real result.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function killByMarker(marker) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const quoted = marker.replace(/'/g, "''");
      const script =
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" +
        quoted +
        "') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], () => resolve());
    } else {
      // Exit status 1 just means nothing matched.
      execFile("pkill", ["-9", "-f", escapeRegex(marker)], () => resolve());
    }
  });
}

// Remove every entry of `dir` whose name contains `token`: the partial output
// and whatever scratch the worker derived from its name (`.hls-tmp`,
// `.trim-tmp`, `.concat-tmp`, remux temp files).
async function removeByToken(dir, token) {
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.includes(token))
      .map((name) => fs.promises.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {}))
  );
}

function createTaskJournal({ file, logEvent }) {
  // taskId -> [{ marker, dir?, token?, path? }]. Starts with whatever the
  // previous session left unfinished; sweep() clears those out one by one, so
  // tasks queued meanwhile are recorded alongside them safely.
  const entries = new Map();
  const staleIds = [];
  try {
    for (const [id, items] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
      if (Array.isArray(items)) {
        entries.set(id, items);
        staleIds.push(id);
      }
    }
  } catch {
    /* no journal: clean shutdown last time */
  }

  function persist() {
    const data = Object.fromEntries(entries);
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (error) {
      logEvent("warn", "Could not write task journal", { error: error.message });
    }
  }

  // item: { marker, token, dir } for token-named scratch in `dir`, or
  //       { marker, path } for a scratch directory owned by the task.
  function track(taskId, item) {
    if (!entries.has(taskId)) entries.set(taskId, []);
    entries.get(taskId).push(item);
    persist();
  }

  function release(taskId) {
    if (entries.delete(taskId)) persist();
  }

  async function cleanItem(item) {
    if (item.marker) await killByMarker(item.marker);
    if (item.path) await fs.promises.rm(item.path, { recursive: true, force: true }).catch(() => {});
    if (item.dir && item.token) await removeByToken(item.dir, item.token);
  }

  // Run once at startup.
  async function sweep() {
    if (staleIds.length === 0) return;
    logEvent("warn", "Cleaning up after tasks interrupted last session", { tasks: staleIds.length });
    for (const id of staleIds.splice(0)) {
      for (const item of entries.get(id) || []) await cleanItem(item);
      release(id);
    }
  }

  return { track, release, sweep, removeByToken };
}

module.exports = { createTaskJournal, removeByToken };
