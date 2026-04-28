const scanForm = document.querySelector("#scanForm");
const urlInput = document.querySelector("#urlInput");
const scanButton = document.querySelector("#scanButton");
const stopButton = document.querySelector("#stopButton");
const scanStatus = document.querySelector("#scanStatus");
const foundCount = document.querySelector("#foundCount");
const directCount = document.querySelector("#directCount");
const streamCount = document.querySelector("#streamCount");
const downloadState = document.querySelector("#downloadState");
const progressBar = document.querySelector("#progressBar");
const emptyState = document.querySelector("#emptyState");
const results = document.querySelector("#results");
const kindFilter = document.querySelector("#kindFilter");
const logList = document.querySelector("#logList");
const clearLogsButton = document.querySelector("#clearLogsButton");

const state = {
  items: new Map(),
  downloads: new Map(),
  scanning: false,
  logs: [],
};

function isStream(item) {
  return item.kind === "HLS" || item.kind === "DASH";
}

function formatBytes(bytes) {
  if (!bytes) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function setScanning(scanning) {
  state.scanning = scanning;
  scanButton.disabled = scanning;
  stopButton.disabled = !scanning;
  scanButton.textContent = scanning ? "Scanning" : "Scan";
}

function updateMetrics() {
  const items = Array.from(state.items.values());
  foundCount.textContent = String(items.length);
  directCount.textContent = String(items.filter((item) => !isStream(item)).length);
  streamCount.textContent = String(items.filter(isStream).length);
}

function visibleItems() {
  const filter = kindFilter.value;
  return Array.from(state.items.values()).filter((item) => {
    if (filter === "direct") return !isStream(item);
    if (filter === "streams") return isStream(item);
    return true;
  });
}

function render() {
  const items = visibleItems();
  emptyState.hidden = state.items.size > 0;
  results.replaceChildren(...items.map(renderItem));
  updateMetrics();
}

function formatTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDetails(details) {
  if (!details || Object.keys(details).length === 0) return "";
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
    .join("\n");
}

function addLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 200) state.logs.shift();
  renderLogs();
}

function renderLogs() {
  if (!logList) return;

  const rows = state.logs.slice(-80).map((entry) => {
    const row = document.createElement("div");
    row.className = `log-entry ${entry.level || "info"}`;

    const line = document.createElement("div");
    line.className = "log-line";

    const level = document.createElement("span");
    level.className = "log-level";
    level.textContent = entry.level || "info";

    const message = document.createElement("strong");
    message.textContent = entry.message || "";

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatTime(entry.timestamp);

    line.append(level, message, time);
    row.append(line);

    const details = formatDetails(entry.details);
    if (details) {
      const pre = document.createElement("pre");
      pre.textContent = details;
      row.append(pre);
    }

    return row;
  });

  logList.replaceChildren(...rows);
  logList.scrollTop = logList.scrollHeight;
}

function renderItem(item) {
  const row = document.createElement("article");
  row.className = "resource-card";

  const title = document.createElement("div");
  title.className = "resource-title";

  const name = document.createElement("strong");
  name.textContent = item.fileName || item.kind;

  const badge = document.createElement("span");
  badge.className = isStream(item) ? "badge stream" : "badge";
  badge.textContent = item.kind;

  title.append(name, badge);

  const meta = document.createElement("div");
  meta.className = "resource-meta";
  meta.textContent = `${item.source} · ${item.statusCode || "HTTP"} · ${formatBytes(item.size)}`;

  const url = document.createElement("button");
  url.type = "button";
  url.className = "url-button";
  url.textContent = item.url;
  url.title = item.url;
  url.addEventListener("click", async () => {
    await navigator.clipboard.writeText(item.url);
    scanStatus.textContent = "URL copied";
  });

  const actionBar = document.createElement("div");
  actionBar.className = "resource-actions";

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = isStream(item) ? "Download MP4" : "Download";
  downloadButton.addEventListener("click", () => startDownload(item));

  actionBar.append(downloadButton);

  row.append(title, meta, url, actionBar);
  return row;
}

async function startDownload(item) {
  try {
    downloadState.textContent = "Preparing";
    progressBar.style.width = "0%";
    const result = await window.videoFinder.startDownload(item);
    if (result.canceled) {
      downloadState.textContent = "Canceled";
      return;
    }
    state.downloads.set(item.id, result.filePath);
    downloadState.textContent = "Done";
    progressBar.style.width = "100%";
    await window.videoFinder.showFile(result.filePath);
  } catch (error) {
    downloadState.textContent = "Failed";
    scanStatus.textContent = error.message;
  }
}

scanForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.items.clear();
  addLog({
    level: "info",
    message: "Scan requested",
    timestamp: new Date().toISOString(),
    details: { url: urlInput.value },
  });
  render();
  setScanning(true);
  scanStatus.textContent = "Loading page";

  try {
    await window.videoFinder.startScan(urlInput.value);
  } catch (error) {
    scanStatus.textContent = error.message;
    setScanning(false);
  }
});

stopButton.addEventListener("click", async () => {
  await window.videoFinder.stopScan();
  setScanning(false);
});

clearLogsButton.addEventListener("click", () => {
  state.logs = [];
  renderLogs();
});

kindFilter.addEventListener("change", render);

window.videoFinder.onCandidate((item) => {
  state.items.set(item.url, item);
  render();
});

window.videoFinder.onScanStatus((status) => {
  if (status.state === "loading") {
    scanStatus.textContent = `Loading ${status.pageUrl}`;
    setScanning(true);
  } else if (status.state === "loaded") {
    scanStatus.textContent = "Page loaded";
  } else if (status.state === "idle") {
    scanStatus.textContent = `Scan complete · ${status.count || 0} found`;
    setScanning(false);
  } else if (status.state === "stopped") {
    scanStatus.textContent = "Stopped";
    setScanning(false);
  } else if (status.state === "error") {
    scanStatus.textContent = status.message;
    setScanning(false);
  }
});

window.videoFinder.onDownloadProgress((payload) => {
  if (payload.mode === "hls-segments") {
    if (payload.total > 0) {
      const percent = Math.min((payload.received / payload.total) * 100, 100);
      progressBar.style.width = `${percent}%`;
      downloadState.textContent = `Segments ${payload.received} / ${payload.total} (${percent.toFixed(0)}%)`;
    } else {
      downloadState.textContent = "Downloading segments";
    }
    return;
  }

  if (payload.mode === "hls-merging") {
    downloadState.textContent = "Merging segments";
    progressBar.style.width = "92%";
    return;
  }

  if (payload.mode === "stream") {
    downloadState.textContent = payload.received > 0 ? "Merging stream" : "Starting";
    progressBar.style.width = "55%";
    return;
  }

  if (payload.mode === "remux") {
    downloadState.textContent = "Repairing MP4";
    progressBar.style.width = "85%";
    return;
  }

  if (payload.total > 0) {
    const percent = Math.min((payload.received / payload.total) * 100, 100);
    progressBar.style.width = `${percent}%`;
    downloadState.textContent = `${percent.toFixed(0)}%`;
  } else {
    downloadState.textContent = formatBytes(payload.received);
  }
});

window.videoFinder.onDownloadStatus((payload) => {
  if (payload.state === "downloading") downloadState.textContent = "Downloading";
  if (payload.state === "repairing") downloadState.textContent = "Repairing MP4";
  if (payload.state === "error") downloadState.textContent = "Failed";
  if (payload.state === "done") downloadState.textContent = "Done";
});

window.videoFinder.onAppLog((entry) => {
  addLog(entry);
  if (entry.level === "error") {
    scanStatus.textContent = entry.message;
  }
});

window.videoFinder.onLog((entry) => {
  if (entry.level === "warn") {
    scanStatus.textContent = entry.message;
  }
});

setScanning(false);
