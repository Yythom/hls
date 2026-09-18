const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const fs = require("fs");
const path = require("path");

const { createLogin } = require("./login");
const { createScanner } = require("./scan");
const { createHttpDownloader } = require("./download-http");
const { createFfmpeg } = require("./ffmpeg");
const { createHlsDownloader } = require("./hls");
const { createTools } = require("./tools");
const { createMediaInfo } = require("./media-info");
const { createYtdlp } = require("./ytdlp");
const { createTaskQueue } = require("./task-queue");
const { createTaskHandlers, TASK_PROGRESS_CHANNELS } = require("./task-handlers");
const { currentTask } = require("./task-context");
const { createTaskJournal } = require("./task-journal");
const { registerIpc } = require("./ipc");

let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#f6f5f0",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));

  // The scan tab embeds a <webview> for the user to log in / play videos.
  // Hand its guest webContents to the scanner so it can drive navigation,
  // capture media requests, and inject cookies — all inside this one window.
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    scanner.setScanContents(guest);
  });
}

function getMainWindow() {
  return mainWindow;
}

function send(channel, payload) {
  // Progress from work running inside a queued task belongs to that task.
  const task = currentTask();
  if (task && TASK_PROGRESS_CHANNELS.has(channel)) {
    task.report(channel, payload);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function logEvent(level, message, details = {}) {
  send("app:log", {
    level,
    message,
    details,
    timestamp: new Date().toISOString(),
  });
}

const scanner = createScanner({ send, logEvent });
const ffmpeg = createFfmpeg({ app, makeDownloadHeaders: scanner.makeDownloadHeaders, send, logEvent });
const httpDownloader = createHttpDownloader({
  makeDownloadHeaders: scanner.makeDownloadHeaders,
  remuxMp4File: ffmpeg.remuxMp4File,
  send,
  logEvent,
});
const hlsDownloader = createHlsDownloader({
  makeDownloadHeaders: scanner.makeDownloadHeaders,
  runFfmpeg: ffmpeg.runFfmpeg,
  probeVideoParams: ffmpeg.probeVideoParams,
  downloadFfmpegStream: ffmpeg.downloadFfmpegStream,
  send,
  logEvent,
});
const tools = createTools({
  ffmpegPath: ffmpeg.ffmpegPath,
  ffmpegHeaders: ffmpeg.ffmpegHeaders,
  safeFfmpegArgs: ffmpeg.safeFfmpegArgs,
  send,
  logEvent,
});
const mediaInfo = createMediaInfo({ ffmpegPath: ffmpeg.ffmpegPath });
const ytdlp = createYtdlp({ app, dialog, getMainWindow, ffmpegPath: ffmpeg.ffmpegPath, send, logEvent });
// Scratch left by tasks the previous session never finished (crash / force
// quit): the journal remembers it; yt-dlp's per-task temp dirs live here.
// One subdir per session, so startup cleanup of older sessions can never touch
// a task queued while that cleanup is still running.
const taskTmpParent = path.join(app.getPath("userData"), "task-tmp");
const taskTmpRoot = path.join(taskTmpParent, String(Date.now()));
const taskJournal = createTaskJournal({ file: path.join(app.getPath("userData"), "task-journal.json"), logEvent });
const taskQueue = createTaskQueue({
  handlers: createTaskHandlers({ ytdlp, httpDownloader, hlsDownloader, tools, tmpRoot: taskTmpRoot, logEvent }),
  journal: taskJournal,
  send,
  logEvent,
});
const login = createLogin({ app, BrowserWindow, session, getMainWindow, logEvent });

registerIpc({
  ipcMain,
  getMainWindow,
  scanner,
  login,
  tools,
  mediaInfo,
  ytdlp,
  taskQueue,
  logEvent,
});

async function cleanUpInterruptedTasks() {
  // Kill orphaned ffmpeg / yt-dlp first so nothing is still writing.
  await taskJournal.sweep();
  const current = path.basename(taskTmpRoot);
  const stale = await fs.promises.readdir(taskTmpParent).catch(() => []);
  await Promise.all(
    stale
      .filter((name) => name !== current)
      .map((name) => fs.promises.rm(path.join(taskTmpParent, name), { recursive: true, force: true }))
  );
}

app.whenReady().then(() => {
  createMainWindow();
  cleanUpInterruptedTasks().catch((error) =>
    logEvent("warn", "Startup cleanup failed", { error: error.message })
  );
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
let tasksShutDown = false;
app.on("before-quit", (event) => {
  if (!tasksShutDown) {
    const active = taskQueue.activeCount();
    if (active > 0) {
      const choice = dialog.showMessageBoxSync(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
        type: "warning",
        buttons: ["取消任务并退出", "继续任务"],
        defaultId: 1,
        cancelId: 1,
        message: `还有 ${active} 个任务未完成`,
        detail: "退出会取消这些任务，并删除它们未完成的临时文件。",
      });
      if (choice !== 0) {
        event.preventDefault();
        return;
      }
    }
    // Hold the quit until running jobs have killed their processes and
    // deleted partial files, then quit for real.
    event.preventDefault();
    tasksShutDown = true;
    taskQueue.shutdown().finally(() => app.quit());
    return;
  }
  scanner.resetScan();
  login.closeActive();
});
