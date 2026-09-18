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
  downloadPickOutput: (item) => ipcRenderer.invoke("download:pickOutput", item),
  taskAdd: (entries) => ipcRenderer.invoke("task:add", entries),
  taskCancel: (id) => ipcRenderer.invoke("task:cancel", id),
  taskCancelAll: () => ipcRenderer.invoke("task:cancelAll"),
  taskRetry: (id) => ipcRenderer.invoke("task:retry", id),
  taskRemove: (id) => ipcRenderer.invoke("task:remove", id),
  taskClearFinished: () => ipcRenderer.invoke("task:clearFinished"),
  taskSetLimit: (lane, n) => ipcRenderer.invoke("task:setLimit", lane, n),
  taskList: () => ipcRenderer.invoke("task:list"),
  onTaskUpdate: (callback) => {
    ipcRenderer.on("task:update", (_event, payload) => callback(payload));
  },
  showFile: (filePath) => ipcRenderer.invoke("file:show", filePath),
  generateThumbnail: (item) => ipcRenderer.invoke("thumbnail:generate", item),
  onCandidate: (callback) => {
    ipcRenderer.on("scan:candidate", (_event, payload) => callback(payload));
  },
  onScanStatus: (callback) => {
    ipcRenderer.on("scan:status", (_event, payload) => callback(payload));
  },
  onLog: (callback) => {
    ipcRenderer.on("scan:log", (_event, payload) => callback(payload));
  },
  onAppLog: (callback) => {
    ipcRenderer.on("app:log", (_event, payload) => callback(payload));
  },
  trimPickInput: () => ipcRenderer.invoke("trim:pickInput"),
  trimPickOutput: (suggestedName) => ipcRenderer.invoke("trim:pickOutput", suggestedName),
  infoPickFile: () => ipcRenderer.invoke("info:pickFile"),
  infoProbe: (filePath) => ipcRenderer.invoke("info:probe", filePath),
  dlpListFormats: (url) => ipcRenderer.invoke("dlp:listFormats", url),
  dlpPickOutput: (options) => ipcRenderer.invoke("dlp:pickOutput", options),
  dlpListPlaylist: (payload) => ipcRenderer.invoke("dlp:listPlaylist", payload),
  dlpPickDir: () => ipcRenderer.invoke("dlp:pickDir"),
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
});
