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

function registerIpc({ ipcMain, getMainWindow, scanner, httpDownloader, hlsDownloader, tools, mediaInfo, ytdlp, send, logEvent }) {
  ipcMain.handle("scan:start", async (_event, payload) => {
    if (payload && typeof payload === "object") {
      return scanner.startScan(payload.url, { cookiesFromBrowser: payload.cookiesFromBrowser });
    }
    return scanner.startScan(payload);
  });
  ipcMain.handle("scan:stop", async () => scanner.stopScan());

  ipcMain.handle("download:start", async (_event, item) => {
    const defaultPath = path.join(app.getPath("downloads"), outputFileNameForCandidate(item));
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: isStreamItem(item) ? "Save HLS video" : "Save video",
      defaultPath,
      buttonLabel: "Save",
      filters: isStreamItem(item)
        ? [{ name: "MP4 Video", extensions: ["mp4"] }]
        : [{ name: "Video", extensions: ["mp4", "webm", "m4v", "mov", "mkv", "avi", "flv"] }],
    });
    if (result.canceled || !result.filePath) {
      logEvent("info", "Download canceled", { url: item.url });
      return { canceled: true };
    }
    send("download:status", { id: item.id, state: "downloading", filePath: result.filePath });
    logEvent("info", "Download selected", { url: item.url, filePath: result.filePath, kind: item.kind, contentType: item.contentType, size: item.size });
    try {
      const download = isStreamItem(item) ? await hlsDownloader.downloadStreamCandidate(item, result.filePath) : await httpDownloader.downloadCandidate(item, result.filePath);
      send("download:status", { id: item.id, state: "done", filePath: result.filePath });
      logEvent("info", "Download finished", { filePath: result.filePath });
      return download;
    } catch (error) {
      send("download:status", { id: item.id, state: "error", message: error.message });
      logEvent("error", "Download failed", { url: item.url, filePath: result.filePath, error: error.message });
      throw error;
    }
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
  ipcMain.handle("trim:run", async (_event, options) => {
    const { input, output, ranges, mode, duration } = options || {};
    if (!input || !output) throw new Error("Input and output paths are required.");
    if (!Array.isArray(ranges) || ranges.length === 0) throw new Error("At least one delete range is required.");
    const totalDuration = Number(duration) > 0 ? Number(duration) : await tools.probeDuration(input);
    const deleteRanges = tools.normalizeDeleteRanges(ranges, totalDuration);
    if (deleteRanges.length === 0) throw new Error("No valid delete ranges after parsing.");
    const keepRanges = tools.computeKeepRanges(deleteRanges, totalDuration);
    if (keepRanges.length === 0) throw new Error("Delete ranges cover the entire video; nothing left to keep.");
    const totalKept = keepRanges.reduce((acc, [a, b]) => acc + (b - a), 0);
    const item = { id: "trim-" + Date.now() };
    logEvent("info", "Trim starting", { input, output, mode, totalDuration, totalKept, deleteRanges: deleteRanges.map(([a, b]) => tools.formatTimecode(a) + "-" + tools.formatTimecode(b)), keepRanges: keepRanges.map(([a, b]) => tools.formatTimecode(a) + "-" + tools.formatTimecode(b)) });
    send("trim:status", { id: item.id, state: "running", mode, totalKept });
    try {
      if (mode === "fast") await tools.runTrimFast(input, output, keepRanges, item);
      else await tools.runTrimAccurate(input, output, deleteRanges, totalKept, item);
      const stat = await fs.promises.stat(output);
      if (stat.size < 1024) throw new Error("Output looks too small (" + stat.size + " bytes).");
      send("trim:status", { id: item.id, state: "done", filePath: output });
      logEvent("info", "Trim completed", { output, size: stat.size });
      return { ok: true, filePath: output, size: stat.size, totalKept };
    } catch (error) { await fs.promises.rm(output, { force: true }); send("trim:status", { id: item.id, state: "error", message: error.message }); logEvent("error", "Trim failed", { error: error.message }); throw error; }
  });
  ipcMain.handle("trim:cancel", async () => tools.cancelTrim());

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
  ipcMain.handle("tools:run", async (_event, payload) => {
    const { op, input, inputs, output, options } = payload || {};
    if (!output) throw new Error("Output path is required.");
    const item = { id: "tools-" + op + "-" + Date.now() };
    send("tools:status", { id: item.id, state: "running", op });
    logEvent("info", "Tool starting", { op, output, options });
    try {
      let totalDuration = 0;
      if (op !== "concat" && op !== "gif" && op !== "image" && input) { try { totalDuration = await tools.probeDuration(input); } catch { /* probe is best-effort */ } }
      if (op === "audio") { if (!input) throw new Error("Input file is required."); await tools.runExtractAudio(input, output, options, item, totalDuration); }
      else if (op === "convert") { if (!input) throw new Error("Input file is required."); await tools.runConvert(input, output, options, item, totalDuration); }
      else if (op === "image") { if (!input) throw new Error("Input file is required."); await tools.runImage(input, output, options, item); }
      else if (op === "watermark") { if (!input) throw new Error("Input file is required."); await tools.runWatermark(input, output, options, item, totalDuration); }
      else if (op === "gif") { if (!input) throw new Error("Input file is required."); await tools.runGif(input, output, options, item); }
      else if (op === "concat") { if (!Array.isArray(inputs) || inputs.length < 2) throw new Error("At least two input files are required."); await tools.runConcat(inputs, output, options, item); }
      else throw new Error("Unsupported operation: " + op);
      const stat = await fs.promises.stat(output);
      send("tools:status", { id: item.id, state: "done", op, filePath: output });
      logEvent("info", "Tool completed", { op, output, size: stat.size });
      return { ok: true, filePath: output, size: stat.size };
    } catch (error) { await fs.promises.rm(output, { force: true }).catch(() => {}); send("tools:status", { id: item.id, state: "error", op, message: error.message }); logEvent("error", "Tool failed", { op, error: error.message }); throw error; }
  });
  ipcMain.handle("tools:cancel", async () => tools.cancelTools());
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
  ipcMain.handle("dlp:download", async (_event, payload) => ytdlp.download(payload));
  ipcMain.handle("dlp:cancel", async () => ytdlp.cancel());
  ipcMain.handle("dlp:checkUpdate", async () => ytdlp.checkUpdate());
  ipcMain.handle("dlp:update", async () => ytdlp.update());
}

module.exports = { registerIpc };
