const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoFinder", {
  startScan: (url) => ipcRenderer.invoke("scan:start", url),
  stopScan: () => ipcRenderer.invoke("scan:stop"),
  startDownload: (item) => ipcRenderer.invoke("download:start", item),
  showFile: (filePath) => ipcRenderer.invoke("file:show", filePath),
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
});
