const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");

const { createScanner } = require("./scan");
const { createHttpDownloader } = require("./download-http");
const { createFfmpeg } = require("./ffmpeg");
const { createHlsDownloader } = require("./hls");
const { createTools } = require("./tools");
const { createMediaInfo } = require("./media-info");
const { createYtdlp } = require("./ytdlp");
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
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
}

function getMainWindow() {
  return mainWindow;
}

function send(channel, payload) {
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

const scanner = createScanner({ BrowserWindow, send, logEvent });
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

registerIpc({
  ipcMain,
  getMainWindow,
  scanner,
  httpDownloader,
  hlsDownloader,
  tools,
  mediaInfo,
  ytdlp,
  send,
  logEvent,
});

app.whenReady().then(createMainWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
app.on("before-quit", scanner.closeScanWindow);
