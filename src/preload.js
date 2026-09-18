const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("videoFinder", {
  pathForFile: (file) => {
    try {
      return webUtils?.getPathForFile?.(file) || file?.path || "";
    } catch {
      return file?.path || "";
    }
  },
  startScan: (url) => ipcRenderer.invoke("scan:start", { url }),
  stopScan: () => ipcRenderer.invoke("scan:stop"),
  startDownload: (item) => ipcRenderer.invoke("download:start", item),
  showFile: (filePath) => ipcRenderer.invoke("file:show", filePath),
  generateThumbnail: (item) => ipcRenderer.invoke("thumbnail:generate", item),
  onCandidate: (callback) => {
    ipcRenderer.on("scan:candidate", (_event, payload) => callback(payload));
  },
  onScanStatus: (callback) => {
    ipcRenderer.on("scan:status", (_event, payload) => callback(payload));
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.on("download:progress", (_event, payload) => callback(payload));
  },
  onDownloadStatus: (callback) => {
    ipcRenderer.on("download:status", (_event, payload) => callback(payload));
  },
  onLog: (callback) => {
    ipcRenderer.on("scan:log", (_event, payload) => callback(payload));
  },
  onAppLog: (callback) => {
    ipcRenderer.on("app:log", (_event, payload) => callback(payload));
  },
  trimPickInput: () => ipcRenderer.invoke("trim:pickInput"),
  trimPickOutput: (suggestedName) => ipcRenderer.invoke("trim:pickOutput", suggestedName),
  trimRun: (options) => ipcRenderer.invoke("trim:run", options),
  trimCancel: () => ipcRenderer.invoke("trim:cancel"),
  onTrimProgress: (callback) => {
    ipcRenderer.on("trim:progress", (_event, payload) => callback(payload));
  },
  onTrimStatus: (callback) => {
    ipcRenderer.on("trim:status", (_event, payload) => callback(payload));
  },
  infoPickFile: () => ipcRenderer.invoke("info:pickFile"),
  infoProbe: (filePath) => ipcRenderer.invoke("info:probe", filePath),
  dlpListFormats: (url) => ipcRenderer.invoke("dlp:listFormats", url),
  dlpPickOutput: (options) => ipcRenderer.invoke("dlp:pickOutput", options),
  dlpListPlaylist: (payload) => ipcRenderer.invoke("dlp:listPlaylist", payload),
  dlpPickDir: () => ipcRenderer.invoke("dlp:pickDir"),
  dlpQueueAdd: (jobs) => ipcRenderer.invoke("dlp:queueAdd", jobs),
  dlpQueueCancel: (id) => ipcRenderer.invoke("dlp:queueCancel", id),
  dlpQueueCancelAll: () => ipcRenderer.invoke("dlp:queueCancelAll"),
  dlpQueueRetry: (id) => ipcRenderer.invoke("dlp:queueRetry", id),
  dlpQueueRemove: (id) => ipcRenderer.invoke("dlp:queueRemove", id),
  dlpQueueClearFinished: () => ipcRenderer.invoke("dlp:queueClearFinished"),
  dlpQueueSetParallel: (n) => ipcRenderer.invoke("dlp:queueSetParallel", n),
  dlpQueueList: () => ipcRenderer.invoke("dlp:queueList"),
  onDlpQueue: (callback) => {
    ipcRenderer.on("dlp:queue", (_event, payload) => callback(payload));
  },
  loginOpen: (url) => ipcRenderer.invoke("login:open", url),
  loginStatus: (url) => ipcRenderer.invoke("login:status", url),
  loginClear: (url) => ipcRenderer.invoke("login:clear", url),
  dlpCheckUpdate: () => ipcRenderer.invoke("dlp:checkUpdate"),
  dlpUpdate: () => ipcRenderer.invoke("dlp:update"),
  onDlpUpdateProgress: (callback) => {
    ipcRenderer.on("dlp:updateProgress", (_event, payload) => callback(payload));
  },
  toolsPickFile: (options) => ipcRenderer.invoke("tools:pickFile", options),
  toolsPickOutput: (options) => ipcRenderer.invoke("tools:pickOutput", options),
  toolsRun: (payload) => ipcRenderer.invoke("tools:run", payload),
  toolsCancel: () => ipcRenderer.invoke("tools:cancel"),
  onToolsProgress: (callback) => {
    ipcRenderer.on("tools:progress", (_event, payload) => callback(payload));
  },
  onToolsStatus: (callback) => {
    ipcRenderer.on("tools:status", (_event, payload) => callback(payload));
  },
});
