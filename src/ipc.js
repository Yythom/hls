const fs = require("fs");
const path = require("path");
const { app, dialog, shell } = require("electron");
const { isStreamItem, outputFileNameForCandidate } = require("./media");

const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "m4s"];
const IMAGE_EXTS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "bmp",
  "gif",
];

function registerIpc({ ipcMain, getMainWindow, scanner, login, tools, mediaInfo, ytdlp, taskQueue, logEvent }) {
  ipcMain.handle("scan:start", async (_event, payload) => {
    const url = payload && typeof payload === "object" ? payload.url : payload;
    return scanner.startScan(url);
  });
  ipcMain.handle("scan:stop", async () => scanner.stopScan());

  ipcMain.handle("download:pickOutput", async (_event, item) => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: isStreamItem(item) ? "Save HLS video" : "Save video",
      defaultPath: path.join(app.getPath("downloads"), outputFileNameForCandidate(item)),
      buttonLabel: "Save",
      filters: isStreamItem(item)
        ? [{ name: "MP4 Video", extensions: ["mp4"] }]
        : [{ name: "Video", extensions: ["mp4", "webm", "m4v", "mov", "mkv", "avi", "flv"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { filePath: result.filePath };
  });

  ipcMain.handle("file:show", async (_event, filePath) => { if (filePath) shell.showItemInFolder(filePath); return { ok: true }; });
  ipcMain.handle("thumbnail:generate", async (_event, item) => {
    if (!item || !item.url) throw new Error("Item with URL is required.");
    try { const dataUrl = await tools.generateThumbnail(item); return { ok: true, dataUrl }; }
    catch (error) { logEvent("warn", "Thumbnail failed", { url: item.url, error: error.message }); throw error; }
  });

  ipcMain.handle("trim:pickInput", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), { title: "Pick a video file", properties: ["openFile"], filters: [{ name: "Video", extensions: VIDEO_EXTS }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    try {
      const [stat, duration] = await Promise.all([fs.promises.stat(filePath), tools.probeDuration(filePath)]);
      return { filePath, fileName: path.basename(filePath), size: stat.size, duration };
    } catch (error) { logEvent("error", "Probe failed", { filePath, error: error.message }); return { error: error.message }; }
  });
  ipcMain.handle("trim:pickOutput", async (_event, suggestedName) => {
    const defaultPath = path.join(app.getPath("downloads"), suggestedName || "trimmed-" + Date.now() + ".mp4");
    const result = await dialog.showSaveDialog(getMainWindow(), { title: "Save trimmed video", defaultPath, filters: [{ name: "MP4 Video", extensions: ["mp4"] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { filePath: result.filePath };
  });
  ipcMain.handle("tools:pickFile", async (_event, options) => {
    const multi = !!options?.multi;
    const kind = options?.kind === "image" ? "image" : "video";
    const filters = options?.filters || (kind === "image" ? [{ name: "Image", extensions: IMAGE_EXTS }, { name: "All", extensions: ["*"] }] : [{ name: "Video", extensions: VIDEO_EXTS }]);
    const result = await dialog.showOpenDialog(getMainWindow(), { title: options?.title || "选择文件", properties: multi ? ["openFile", "multiSelections"] : ["openFile"], filters });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const files = await Promise.all(result.filePaths.map(async (filePath) => {
      try { const stat = await fs.promises.stat(filePath); const duration = kind === "video" ? await tools.probeDuration(filePath).catch(() => 0) : 0; return { filePath, fileName: path.basename(filePath), size: stat.size, duration }; }
      catch (error) { return { filePath, error: error.message }; }
    }));
    return { files };
  });
  ipcMain.handle("tools:pickOutput", async (_event, options) => {
    const suggested = options?.suggestedName || "output-" + Date.now() + "." + (options?.ext || "mp4");
    const ext = options?.ext || "mp4";
    const filters = options?.filters || [{ name: ext.toUpperCase(), extensions: [ext] }];
    const result = await dialog.showSaveDialog(getMainWindow(), { title: options?.title || "保存为", defaultPath: path.join(app.getPath("downloads"), suggested), filters });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { filePath: result.filePath };
  });
  ipcMain.handle("info:pickFile", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), { title: "选择媒体文件", properties: ["openFile"], filters: [{ name: "Media", extensions: mediaInfo.INFO_EXTS }, { name: "All", extensions: ["*"] }] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) };
  });
  ipcMain.handle("info:probe", async (_event, filePath) => {
    if (!filePath) throw new Error("File path is required.");
    const [stat, raw] = await Promise.all([fs.promises.stat(filePath), mediaInfo.probeRawInfo(filePath)]);
    const parsed = mediaInfo.parseMediaInfo(raw);
    return { filePath, fileName: path.basename(filePath), size: stat.size, ...parsed };
  });
  ipcMain.handle("dlp:listFormats", async (_event, payload) => ytdlp.listFormats(payload));
  ipcMain.handle("dlp:pickOutput", async (_event, options) => ytdlp.pickOutput(options));
  ipcMain.handle("dlp:listPlaylist", async (_event, payload) => ytdlp.listPlaylist(payload));
  ipcMain.handle("dlp:pickDir", async () => ytdlp.pickDir());
  ipcMain.handle("task:add", async (_event, entries) => taskQueue.add(entries));
  ipcMain.handle("task:cancel", async (_event, id) => taskQueue.cancel(id));
  ipcMain.handle("task:cancelAll", async () => taskQueue.cancelAll());
  ipcMain.handle("task:retry", async (_event, id) => taskQueue.retry(id));
  ipcMain.handle("task:remove", async (_event, id) => taskQueue.remove(id));
  ipcMain.handle("task:clearFinished", async () => taskQueue.clearFinished());
  ipcMain.handle("task:setLimit", async (_event, lane, n) => taskQueue.setLimit(lane, n));
  ipcMain.handle("task:list", async () => taskQueue.list());
  ipcMain.handle("dlp:checkUpdate", async () => ytdlp.checkUpdate());
  ipcMain.handle("dlp:update", async () => ytdlp.update());

  ipcMain.handle("login:open", async (_event, url) => login.open(url));
  ipcMain.handle("login:status", async (_event, url) => login.status(url));
  ipcMain.handle("login:clear", async (_event, url) => login.clear(url));
}

module.exports = { registerIpc };
