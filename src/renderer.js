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

const trimPickInput = document.querySelector("#trimPickInput");
const trimInputName = document.querySelector("#trimInputName");
const trimDuration = document.querySelector("#trimDuration");
const trimAddRange = document.querySelector("#trimAddRange");
const trimRangesEl = document.querySelector("#trimRanges");
const trimMode = document.querySelector("#trimMode");
const trimPickOutput = document.querySelector("#trimPickOutput");
const trimOutputName = document.querySelector("#trimOutputName");
const trimRun = document.querySelector("#trimRun");
const trimCancel = document.querySelector("#trimCancel");
const trimReveal = document.querySelector("#trimReveal");
const trimState = document.querySelector("#trimState");
const trimProgress = document.querySelector("#trimProgress");

const tabs = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");

const state = {
  items: new Map(),
  downloads: new Map(),
  scanning: false,
  logs: [],
};

const trimStateData = {
  input: null,
  output: null,
  duration: 0,
  running: false,
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

function formatDurationDisplay(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--:--";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function setScanning(scanning) {
  state.scanning = scanning;
  scanButton.disabled = scanning;
  stopButton.disabled = !scanning;
  scanButton.textContent = scanning ? "扫描中" : "扫描";
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

  const previewButton = document.createElement("button");
  previewButton.type = "button";
  previewButton.className = "secondary";
  previewButton.textContent = item.thumbnail ? "刷新预览" : "预览";

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = isStream(item) ? "下载 MP4" : "下载";
  downloadButton.addEventListener("click", () => startDownload(item));

  actionBar.append(previewButton, downloadButton);

  const thumbBox = document.createElement("div");
  thumbBox.className = "resource-thumb";
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.src = item.thumbnail;
    img.alt = "preview";
    thumbBox.append(img);
  } else if (item.thumbnailError) {
    const err = document.createElement("span");
    err.className = "resource-thumb-error";
    err.textContent = `预览失败：${item.thumbnailError}`;
    thumbBox.append(err);
  } else {
    thumbBox.hidden = true;
  }

  previewButton.addEventListener("click", async () => {
    previewButton.disabled = true;
    const original = previewButton.textContent;
    previewButton.textContent = "生成中…";
    thumbBox.hidden = false;
    thumbBox.replaceChildren();
    const placeholder = document.createElement("span");
    placeholder.className = "resource-thumb-loading";
    placeholder.textContent = "正在抓取首帧…";
    thumbBox.append(placeholder);

    try {
      const result = await window.videoFinder.generateThumbnail(item);
      const updated = { ...item, thumbnail: result.dataUrl, thumbnailError: null };
      state.items.set(item.url, updated);
      render();
    } catch (error) {
      const updated = { ...item, thumbnail: null, thumbnailError: error.message };
      state.items.set(item.url, updated);
      render();
    } finally {
      previewButton.disabled = false;
      previewButton.textContent = original;
    }
  });

  row.append(title, meta, url, actionBar, thumbBox);
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
  const existing = state.items.get(item.url);
  const merged = existing
    ? { ...item, thumbnail: existing.thumbnail, thumbnailError: existing.thumbnailError }
    : item;
  state.items.set(item.url, merged);
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

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────

tabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    tabs.forEach((b) => b.classList.toggle("is-active", b === btn));
    tabPanels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== target;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trim
// ─────────────────────────────────────────────────────────────────────────────

function addRangeRow(start = "", end = "") {
  const row = document.createElement("div");
  row.className = "trim-range";

  const startInput = document.createElement("input");
  startInput.type = "text";
  startInput.placeholder = "Start (e.g. 1:30)";
  startInput.value = start;
  startInput.dataset.role = "start";

  const dash = document.createElement("span");
  dash.className = "trim-dash";
  dash.textContent = "—";

  const endInput = document.createElement("input");
  endInput.type = "text";
  endInput.placeholder = "End (e.g. 1:45)";
  endInput.value = end;
  endInput.dataset.role = "end";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "tiny-button";
  remove.textContent = "删除";
  remove.addEventListener("click", () => {
    row.remove();
    if (trimRangesEl.children.length === 0) addRangeRow();
  });

  row.append(startInput, dash, endInput, remove);
  trimRangesEl.append(row);
}

function getRanges() {
  return Array.from(trimRangesEl.querySelectorAll(".trim-range"))
    .map((row) => {
      const start = row.querySelector('[data-role="start"]').value.trim();
      const end = row.querySelector('[data-role="end"]').value.trim();
      return { start, end };
    })
    .filter(({ start, end }) => start !== "" || end !== "");
}

function setTrimRunning(running) {
  trimStateData.running = running;
  trimRun.disabled = running;
  trimCancel.disabled = !running;
  trimPickInput.disabled = running;
  trimPickOutput.disabled = running;
  trimAddRange.disabled = running;
  trimMode.disabled = running;
}

function suggestOutputName(inputName) {
  if (!inputName) return null;
  const dot = inputName.lastIndexOf(".");
  const stem = dot > 0 ? inputName.slice(0, dot) : inputName;
  return `${stem}_trimmed.mp4`;
}

trimPickInput.addEventListener("click", async () => {
  const result = await window.videoFinder.trimPickInput();
  if (!result || result.canceled) return;
  if (result.error) {
    trimState.textContent = result.error;
    return;
  }
  trimStateData.input = result.filePath;
  trimStateData.duration = result.duration;
  trimInputName.textContent = `${result.fileName} · ${formatBytes(result.size)}`;
  trimDuration.textContent = `${formatDurationDisplay(result.duration)} (${result.duration.toFixed(2)}s)`;
  trimState.textContent = "Ready";
  trimProgress.style.width = "0%";
  trimReveal.hidden = true;
});

trimPickOutput.addEventListener("click", async () => {
  const suggested = suggestOutputName(trimInputName.textContent.split(" · ")[0]);
  const result = await window.videoFinder.trimPickOutput(suggested);
  if (!result || result.canceled) return;
  trimStateData.output = result.filePath;
  trimOutputName.textContent = result.filePath;
});

trimAddRange.addEventListener("click", () => addRangeRow());

trimRun.addEventListener("click", async () => {
  if (!trimStateData.input) {
    trimState.textContent = "Pick a source video first";
    return;
  }
  if (!trimStateData.output) {
    trimState.textContent = "Choose an output location first";
    return;
  }
  const ranges = getRanges();
  if (ranges.length === 0) {
    trimState.textContent = "Add at least one delete range";
    return;
  }

  setTrimRunning(true);
  trimState.textContent = "Starting";
  trimProgress.style.width = "0%";
  trimReveal.hidden = true;

  try {
    const result = await window.videoFinder.trimRun({
      input: trimStateData.input,
      output: trimStateData.output,
      ranges,
      mode: trimMode.value,
      duration: trimStateData.duration,
    });
    trimState.textContent = `Done · ${formatBytes(result.size)} · kept ${result.totalKept.toFixed(2)}s`;
    trimProgress.style.width = "100%";
    trimReveal.hidden = false;
  } catch (error) {
    trimState.textContent = `Failed: ${error.message}`;
  } finally {
    setTrimRunning(false);
  }
});

trimCancel.addEventListener("click", async () => {
  await window.videoFinder.trimCancel();
  trimState.textContent = "Canceling…";
});

trimReveal.addEventListener("click", async () => {
  if (trimStateData.output) await window.videoFinder.showFile(trimStateData.output);
});

window.videoFinder.onTrimProgress((payload) => {
  if (payload.phase === "encoding") {
    if (payload.total > 0) {
      const percent = Math.min((payload.elapsed / payload.total) * 100, 100);
      trimProgress.style.width = `${percent}%`;
      trimState.textContent = `Encoding ${formatDurationDisplay(payload.elapsed)} / ${formatDurationDisplay(
        payload.total
      )} (${percent.toFixed(0)}%)`;
    } else {
      trimState.textContent = `Encoding ${formatDurationDisplay(payload.elapsed)}`;
    }
    return;
  }
  if (payload.phase === "extracting") {
    const percent = ((payload.segmentIndex + 1) / payload.totalSegments) * 100;
    trimProgress.style.width = `${percent}%`;
    trimState.textContent = `Extracting segment ${payload.segmentIndex + 1} / ${payload.totalSegments}`;
    return;
  }
  if (payload.phase === "concatenating") {
    trimProgress.style.width = "95%";
    trimState.textContent = "Merging segments";
  }
});

window.videoFinder.onTrimStatus((payload) => {
  if (payload.state === "running") {
    trimState.textContent = `Running (${payload.mode})`;
  } else if (payload.state === "done") {
    trimState.textContent = "Done";
  } else if (payload.state === "error") {
    trimState.textContent = payload.message || "Failed";
  }
});

addRangeRow();

// ─────────────────────────────────────────────────────────────────────────────
// Shared tool helpers
// ─────────────────────────────────────────────────────────────────────────────

function stemOf(name) {
  if (!name) return "output";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function makeTool({
  op,
  pickInputBtn,
  inputNameEl,
  pickOutputBtn,
  outputNameEl,
  runBtn,
  cancelBtn,
  revealBtn,
  stateEl,
  progressEl,
  controlEls = [],
  getOutputExt,
  getRunPayload,
  validate,
}) {
  const tool = {
    input: null,
    inputName: null,
    output: null,
    duration: 0,
    running: false,
  };

  function setRunning(running) {
    tool.running = running;
    runBtn.disabled = running;
    cancelBtn.disabled = !running;
    if (pickInputBtn) pickInputBtn.disabled = running;
    if (pickOutputBtn) pickOutputBtn.disabled = running;
    controlEls.forEach((el) => {
      if (el) el.disabled = running;
    });
  }

  if (pickInputBtn) {
    pickInputBtn.addEventListener("click", async () => {
      const result = await window.videoFinder.toolsPickFile({ title: "选择源视频" });
      if (!result || result.canceled) return;
      const file = result.files?.[0];
      if (!file || file.error) {
        stateEl.textContent = file?.error || "读取失败";
        return;
      }
      tool.input = file.filePath;
      tool.inputName = file.fileName;
      tool.duration = file.duration || 0;
      inputNameEl.textContent = `${file.fileName} · ${formatBytes(file.size)}${
        file.duration ? ` · ${formatDurationDisplay(file.duration)}` : ""
      }`;
      stateEl.textContent = "Ready";
      progressEl.style.width = "0%";
      revealBtn.hidden = true;
    });
  }

  pickOutputBtn.addEventListener("click", async () => {
    const ext = typeof getOutputExt === "function" ? getOutputExt(tool) : "mp4";
    const stem = stemOf(tool.inputName) || `output-${Date.now()}`;
    const result = await window.videoFinder.toolsPickOutput({
      title: "保存输出",
      ext,
      suggestedName: `${stem}_${op}.${ext}`,
    });
    if (!result || result.canceled) return;
    tool.output = result.filePath;
    outputNameEl.textContent = result.filePath;
  });

  runBtn.addEventListener("click", async () => {
    if (validate) {
      const err = validate(tool);
      if (err) {
        stateEl.textContent = err;
        return;
      }
    }
    if (!tool.output) {
      stateEl.textContent = "请先选择保存位置";
      return;
    }

    setRunning(true);
    stateEl.textContent = "启动中";
    progressEl.style.width = "0%";
    revealBtn.hidden = true;

    try {
      const payload = getRunPayload(tool);
      const result = await window.videoFinder.toolsRun(payload);
      stateEl.textContent = `完成 · ${formatBytes(result.size)}`;
      progressEl.style.width = "100%";
      revealBtn.hidden = false;
    } catch (error) {
      stateEl.textContent = `失败：${error.message}`;
    } finally {
      setRunning(false);
    }
  });

  cancelBtn.addEventListener("click", async () => {
    await window.videoFinder.toolsCancel();
    stateEl.textContent = "正在取消…";
  });

  revealBtn.addEventListener("click", async () => {
    if (tool.output) await window.videoFinder.showFile(tool.output);
  });

  return tool;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio extract
// ─────────────────────────────────────────────────────────────────────────────

const audioFormat = document.querySelector("#audioFormat");
const audioState = document.querySelector("#audioState");
const audioProgress = document.querySelector("#audioProgress");
const AUDIO_EXT = { mp3: "mp3", aac: "m4a", wav: "wav", flac: "flac" };

makeTool({
  op: "audio",
  pickInputBtn: document.querySelector("#audioPickInput"),
  inputNameEl: document.querySelector("#audioInputName"),
  pickOutputBtn: document.querySelector("#audioPickOutput"),
  outputNameEl: document.querySelector("#audioOutputName"),
  runBtn: document.querySelector("#audioRun"),
  cancelBtn: document.querySelector("#audioCancel"),
  revealBtn: document.querySelector("#audioReveal"),
  stateEl: audioState,
  progressEl: audioProgress,
  controlEls: [audioFormat],
  getOutputExt: () => AUDIO_EXT[audioFormat.value] || "mp3",
  validate: (t) => (t.input ? null : "请先选择源视频"),
  getRunPayload: (t) => ({
    op: "audio",
    input: t.input,
    output: t.output,
    options: { format: audioFormat.value },
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Format convert
// ─────────────────────────────────────────────────────────────────────────────

const convertFormat = document.querySelector("#convertFormat");
const convertMode = document.querySelector("#convertMode");
const convertScale = document.querySelector("#convertScale");
const convertState = document.querySelector("#convertState");
const convertProgress = document.querySelector("#convertProgress");

makeTool({
  op: "convert",
  pickInputBtn: document.querySelector("#convertPickInput"),
  inputNameEl: document.querySelector("#convertInputName"),
  pickOutputBtn: document.querySelector("#convertPickOutput"),
  outputNameEl: document.querySelector("#convertOutputName"),
  runBtn: document.querySelector("#convertRun"),
  cancelBtn: document.querySelector("#convertCancel"),
  revealBtn: document.querySelector("#convertReveal"),
  stateEl: convertState,
  progressEl: convertProgress,
  controlEls: [convertFormat, convertMode, convertScale],
  getOutputExt: () => convertFormat.value || "mp4",
  validate: (t) => (t.input ? null : "请先选择源视频"),
  getRunPayload: (t) => ({
    op: "convert",
    input: t.input,
    output: t.output,
    options: { mode: convertMode.value, scale: convertScale.value },
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// GIF
// ─────────────────────────────────────────────────────────────────────────────

const gifStart = document.querySelector("#gifStart");
const gifDuration = document.querySelector("#gifDuration");
const gifFps = document.querySelector("#gifFps");
const gifWidth = document.querySelector("#gifWidth");
const gifState = document.querySelector("#gifState");
const gifProgress = document.querySelector("#gifProgress");

makeTool({
  op: "gif",
  pickInputBtn: document.querySelector("#gifPickInput"),
  inputNameEl: document.querySelector("#gifInputName"),
  pickOutputBtn: document.querySelector("#gifPickOutput"),
  outputNameEl: document.querySelector("#gifOutputName"),
  runBtn: document.querySelector("#gifRun"),
  cancelBtn: document.querySelector("#gifCancel"),
  revealBtn: document.querySelector("#gifReveal"),
  stateEl: gifState,
  progressEl: gifProgress,
  controlEls: [gifStart, gifDuration, gifFps, gifWidth],
  getOutputExt: () => "gif",
  validate: (t) => (t.input ? null : "请先选择源视频"),
  getRunPayload: (t) => ({
    op: "gif",
    input: t.input,
    output: t.output,
    options: {
      start: gifStart.value || "0",
      duration: gifDuration.value || "",
      fps: gifFps.value,
      width: gifWidth.value,
    },
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Concat
// ─────────────────────────────────────────────────────────────────────────────

const concatList = document.querySelector("#concatList");
const concatMode = document.querySelector("#concatMode");
const concatState = document.querySelector("#concatState");
const concatProgress = document.querySelector("#concatProgress");
const concatRun = document.querySelector("#concatRun");
const concatCancel = document.querySelector("#concatCancel");
const concatReveal = document.querySelector("#concatReveal");
const concatPickOutput = document.querySelector("#concatPickOutput");
const concatOutputName = document.querySelector("#concatOutputName");
const concatAdd = document.querySelector("#concatAdd");
const concatClear = document.querySelector("#concatClear");

const concatData = {
  files: [],
  output: null,
  running: false,
};

function renderConcatList() {
  concatList.replaceChildren(
    ...concatData.files.map((file, idx) => {
      const row = document.createElement("div");
      row.className = "trim-range";

      const label = document.createElement("span");
      label.className = "trim-muted";
      label.textContent = `${idx + 1}. ${file.fileName}${
        file.duration ? ` · ${formatDurationDisplay(file.duration)}` : ""
      }`;
      label.style.gridColumn = "1 / span 3";
      label.style.fontFamily = "inherit";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tiny-button";
      remove.textContent = "移除";
      remove.addEventListener("click", () => {
        concatData.files.splice(idx, 1);
        renderConcatList();
      });

      row.append(label, remove);
      return row;
    })
  );
}

concatAdd.addEventListener("click", async () => {
  const result = await window.videoFinder.toolsPickFile({
    title: "选择要拼接的视频",
    multi: true,
  });
  if (!result || result.canceled) return;
  for (const file of result.files || []) {
    if (file.error) continue;
    concatData.files.push(file);
  }
  renderConcatList();
});

concatClear.addEventListener("click", () => {
  concatData.files = [];
  renderConcatList();
});

concatPickOutput.addEventListener("click", async () => {
  const result = await window.videoFinder.toolsPickOutput({
    title: "保存拼接结果",
    ext: "mp4",
    suggestedName: `concat-${Date.now()}.mp4`,
  });
  if (!result || result.canceled) return;
  concatData.output = result.filePath;
  concatOutputName.textContent = result.filePath;
});

function setConcatRunning(running) {
  concatData.running = running;
  concatRun.disabled = running;
  concatCancel.disabled = !running;
  concatAdd.disabled = running;
  concatClear.disabled = running;
  concatPickOutput.disabled = running;
  concatMode.disabled = running;
}

concatRun.addEventListener("click", async () => {
  if (concatData.files.length < 2) {
    concatState.textContent = "至少需要两个视频";
    return;
  }
  if (!concatData.output) {
    concatState.textContent = "请先选择保存位置";
    return;
  }

  setConcatRunning(true);
  concatState.textContent = "启动中";
  concatProgress.style.width = "0%";
  concatReveal.hidden = true;

  try {
    const result = await window.videoFinder.toolsRun({
      op: "concat",
      inputs: concatData.files.map((f) => f.filePath),
      output: concatData.output,
      options: { mode: concatMode.value },
    });
    concatState.textContent = `完成 · ${formatBytes(result.size)}`;
    concatProgress.style.width = "100%";
    concatReveal.hidden = false;
  } catch (error) {
    concatState.textContent = `失败：${error.message}`;
  } finally {
    setConcatRunning(false);
  }
});

concatCancel.addEventListener("click", async () => {
  await window.videoFinder.toolsCancel();
  concatState.textContent = "正在取消…";
});

concatReveal.addEventListener("click", async () => {
  if (concatData.output) await window.videoFinder.showFile(concatData.output);
});

renderConcatList();

// ─────────────────────────────────────────────────────────────────────────────
// Tool progress dispatch
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_STATE_ELS = {
  audio: { state: audioState, progress: audioProgress },
  convert: { state: convertState, progress: convertProgress },
  gif: { state: gifState, progress: gifProgress },
  concat: { state: concatState, progress: concatProgress },
};

function toolKindFromId(id) {
  if (!id) return null;
  const m = String(id).match(/^tools-([^-]+)-/);
  return m ? m[1] : null;
}

window.videoFinder.onToolsProgress((payload) => {
  const kind = toolKindFromId(payload.id);
  const els = TOOL_STATE_ELS[kind];
  if (!els) return;

  if (payload.phase === "concatenating") {
    els.state.textContent = "合并中";
    els.progress.style.width = "92%";
    return;
  }
  if (payload.phase === "encoding") {
    if (payload.total > 0) {
      const percent = Math.min((payload.elapsed / payload.total) * 100, 100);
      els.progress.style.width = `${percent}%`;
      els.state.textContent = `处理中 ${formatDurationDisplay(payload.elapsed)} / ${formatDurationDisplay(
        payload.total
      )} (${percent.toFixed(0)}%)`;
    } else {
      els.state.textContent = `处理中 ${formatDurationDisplay(payload.elapsed)}`;
    }
  }
});

window.videoFinder.onToolsStatus((payload) => {
  const kind = toolKindFromId(payload.id);
  const els = TOOL_STATE_ELS[kind];
  if (!els) return;
  if (payload.state === "running") els.state.textContent = "运行中";
  if (payload.state === "done") els.state.textContent = "完成";
  if (payload.state === "error") els.state.textContent = payload.message || "失败";
});

// ─────────────────────────────────────────────────────────────────────────────
// Media info viewer
// ─────────────────────────────────────────────────────────────────────────────

const infoPickInput = document.querySelector("#infoPickInput");
const infoReveal = document.querySelector("#infoReveal");
const infoInputName = document.querySelector("#infoInputName");
const infoDropZone = document.querySelector("#infoDropZone");
const infoState = document.querySelector("#infoState");
const infoResult = document.querySelector("#infoResult");
const infoOverview = document.querySelector("#infoOverview");
const infoVideoList = document.querySelector("#infoVideoList");
const infoAudioList = document.querySelector("#infoAudioList");
const infoOtherList = document.querySelector("#infoOtherList");
const infoMetadata = document.querySelector("#infoMetadata");
const infoRaw = document.querySelector("#infoRaw");
const infoToggleRaw = document.querySelector("#infoToggleRaw");
const infoCopyJson = document.querySelector("#infoCopyJson");

const infoState_ = { filePath: null, payload: null };

function appendDef(dl, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (value === null || value === undefined || value === "") {
    dd.textContent = "—";
    dd.classList.add("info-empty");
  } else {
    dd.textContent = String(value);
  }
  dl.append(dt, dd);
}

function showSection(name, show) {
  const el = document.querySelector(`.info-section[data-section="${name}"]`);
  if (el) el.hidden = !show;
}

function renderStreamCard(stream) {
  const card = document.createElement("div");
  card.className = "info-stream";

  const header = document.createElement("div");
  header.className = "info-stream-head";
  const title = `#${stream.index}${stream.language ? ` (${stream.language})` : ""}`;
  header.innerHTML = `<strong>${title}</strong><span class="trim-muted">${stream.codec || "?"}${stream.profile ? ` · ${stream.profile}` : ""}</span>`;
  card.append(header);

  const dl = document.createElement("dl");
  dl.className = "info-grid";

  if (stream.kind === "Video") {
    if (stream.width && stream.height) appendDef(dl, "分辨率", `${stream.width} × ${stream.height}`);
    if (stream.dar) appendDef(dl, "显示比例", stream.dar);
    if (stream.fps) appendDef(dl, "帧率", `${stream.fps} fps`);
    if (stream.pixelFormat) appendDef(dl, "像素格式", stream.pixelFormat);
    if (stream.bitrate) appendDef(dl, "码率", `${stream.bitrate} kb/s`);
  } else if (stream.kind === "Audio") {
    if (stream.sampleRate) appendDef(dl, "采样率", `${stream.sampleRate} Hz`);
    if (stream.channels) appendDef(dl, "声道", stream.channels);
    if (stream.bitrate) appendDef(dl, "码率", `${stream.bitrate} kb/s`);
  }
  card.append(dl);

  const raw = document.createElement("div");
  raw.className = "info-stream-raw";
  raw.textContent = stream.raw;
  card.append(raw);

  return card;
}

function formatTimestamp(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString();
}

function renderInfo(payload) {
  infoState_.payload = payload;
  const { info } = payload;

  infoOverview.replaceChildren();
  appendDef(infoOverview, "文件名", payload.fileName);
  appendDef(infoOverview, "路径", payload.filePath);
  appendDef(infoOverview, "大小", formatBytes(payload.size));
  appendDef(infoOverview, "修改时间", formatTimestamp(payload.mtimeMs));
  appendDef(infoOverview, "容器", info.format);
  appendDef(
    infoOverview,
    "时长",
    info.duration
      ? `${formatDurationDisplay(info.duration)} (${info.duration.toFixed(2)}s)`
      : info.durationText || "—"
  );
  appendDef(infoOverview, "总码率", info.bitrateText || (info.bitrate ? `${info.bitrate} kb/s` : "—"));

  if (info.videoStreams.length) {
    showSection("video", true);
    infoVideoList.replaceChildren(...info.videoStreams.map(renderStreamCard));
  } else {
    showSection("video", false);
  }

  if (info.audioStreams.length) {
    showSection("audio", true);
    infoAudioList.replaceChildren(...info.audioStreams.map(renderStreamCard));
  } else {
    showSection("audio", false);
  }

  if (info.otherStreams.length) {
    showSection("other", true);
    infoOtherList.replaceChildren(...info.otherStreams.map(renderStreamCard));
  } else {
    showSection("other", false);
  }

  const metaEntries = Object.entries(info.metadata || {});
  if (metaEntries.length) {
    showSection("meta", true);
    infoMetadata.replaceChildren();
    for (const [k, v] of metaEntries) appendDef(infoMetadata, k, v);
  } else {
    showSection("meta", false);
  }

  infoRaw.textContent = payload.raw || "";
  infoResult.hidden = false;
}

async function probeAndRender(filePath) {
  infoState_.filePath = filePath;
  infoInputName.textContent = filePath;
  infoState.textContent = "解析中…";
  infoResult.hidden = true;
  infoReveal.hidden = true;
  try {
    const payload = await window.videoFinder.infoProbe(filePath);
    renderInfo(payload);
    infoState.textContent = "Ready";
    infoReveal.hidden = false;
  } catch (error) {
    infoState.textContent = `失败：${error.message}`;
  }
}

if (infoPickInput) {
  infoPickInput.addEventListener("click", async () => {
    const result = await window.videoFinder.infoPickFile();
    if (!result || result.canceled) return;
    await probeAndRender(result.filePath);
  });
}

if (infoReveal) {
  infoReveal.addEventListener("click", async () => {
    if (infoState_.filePath) await window.videoFinder.showFile(infoState_.filePath);
  });
}

if (infoToggleRaw) {
  infoToggleRaw.addEventListener("click", () => {
    const showing = !infoRaw.hidden;
    infoRaw.hidden = showing;
    infoToggleRaw.textContent = showing ? "展开" : "收起";
  });
}

if (infoCopyJson) {
  infoCopyJson.addEventListener("click", async () => {
    if (!infoState_.payload) return;
    const json = JSON.stringify(infoState_.payload, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      infoCopyJson.textContent = "已复制";
      setTimeout(() => (infoCopyJson.textContent = "复制 JSON"), 1500);
    } catch {
      infoCopyJson.textContent = "复制失败";
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Online video (yt-dlp: B站 / YouTube / 抖音 / Twitter / etc.)
// ─────────────────────────────────────────────────────────────────────────────

const onlineUrl = document.querySelector("#onlineUrl");
const onlineFetch = document.querySelector("#onlineFetch");
const onlineMeta = document.querySelector("#onlineMeta");
const onlineThumb = document.querySelector("#onlineThumb");
const onlineTitle = document.querySelector("#onlineTitle");
const onlineSubtitle = document.querySelector("#onlineSubtitle");
const onlineFormatsBox = document.querySelector("#onlineFormatsBox");
const onlineFormats = document.querySelector("#onlineFormats");
const onlineKindFilter = document.querySelector("#onlineKindFilter");
const onlinePickOutput = document.querySelector("#onlinePickOutput");
const onlineOutputName = document.querySelector("#onlineOutputName");
const onlineRun = document.querySelector("#onlineRun");
const onlineCancel = document.querySelector("#onlineCancel");
const onlineReveal = document.querySelector("#onlineReveal");
const onlineState = document.querySelector("#onlineState");
const onlineProgress = document.querySelector("#onlineProgress");
const onlineCookies = document.querySelector("#onlineCookies");
const onlineConcurrency = document.querySelector("#onlineConcurrency");

const online = {
  meta: null,
  selectedFormatId: "auto",
  output: null,
  running: false,
};

function sanitizeFilename(name) {
  return (name || "video").replace(/[\/\\?%*:|"<>]/g, "_").slice(0, 120) || "video";
}

function setOnlineRunning(running) {
  online.running = running;
  onlineRun.disabled = running;
  onlineFetch.disabled = running;
  onlineCancel.disabled = !running;
  onlinePickOutput.disabled = running;
  onlineUrl.disabled = running;
}

function chosenFormatExt() {
  if (online.selectedFormatId === "auto") return "mp4";
  const f = online.meta?.formats?.find((x) => x.formatId === online.selectedFormatId);
  return f?.ext || "mp4";
}

function renderFormats() {
  if (!online.meta) return;
  const filter = onlineKindFilter.value;
  const items = online.meta.formats.filter((f) => filter === "all" || f.kind === filter);

  if (filter === "combined") {
    items.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  } else if (filter === "video") {
    items.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  } else if (filter === "audio") {
    items.sort((a, b) => (b.abr || 0) - (a.abr || 0));
  }

  const rows = [];

  if (filter === "combined" || filter === "all") {
    const auto = document.createElement("label");
    auto.className = "online-format is-auto";
    auto.innerHTML = `
      <input type="radio" name="online-format" value="auto" />
      <span class="online-format-main">
        <strong>自动（最佳视频+最佳音频，合并 MP4）</strong>
        <span class="trim-muted">推荐</span>
      </span>
    `;
    rows.push(auto);
  }

  for (const f of items) {
    const row = document.createElement("label");
    row.className = "online-format";
    const sizeText = f.filesize ? formatBytes(f.filesize) : "—";
    const detailParts = [];
    if (f.resolution) detailParts.push(f.resolution);
    if (f.fps) detailParts.push(`${f.fps}fps`);
    if (f.vcodec) detailParts.push(f.vcodec);
    if (f.acodec) detailParts.push(f.acodec);
    if (f.tbr) detailParts.push(`${Math.round(f.tbr)}kbps`);
    if (f.formatNote) detailParts.push(f.formatNote);

    row.innerHTML = `
      <input type="radio" name="online-format" value="${f.formatId}" />
      <span class="online-format-main">
        <strong>${f.formatId} · ${f.ext}${f.kind !== "combined" ? ` · ${f.kind === "video" ? "仅视频" : "仅音频"}` : ""}</strong>
        <span class="trim-muted">${detailParts.join(" · ") || "—"}</span>
      </span>
      <span class="online-format-size trim-muted">${sizeText}</span>
    `;
    rows.push(row);
  }

  onlineFormats.replaceChildren(...rows);

  const first = onlineFormats.querySelector("input[name='online-format']");
  if (first) {
    first.checked = true;
    online.selectedFormatId = first.value;
  }

  onlineFormats.addEventListener(
    "change",
    (event) => {
      if (event.target?.name === "online-format") {
        online.selectedFormatId = event.target.value;
      }
    },
    { once: false }
  );
}

if (onlineKindFilter) {
  onlineKindFilter.addEventListener("change", renderFormats);
}

if (onlineFetch) {
  onlineFetch.addEventListener("click", async () => {
    const url = onlineUrl.value.trim();
    if (!url) {
      onlineState.textContent = "请输入视频 URL";
      return;
    }
    onlineState.textContent = "解析中…";
    onlineMeta.hidden = true;
    onlineFormatsBox.hidden = true;
    onlineProgress.style.width = "0%";
    onlineReveal.hidden = true;
    onlineFetch.disabled = true;
    try {
      const meta = await window.videoFinder.dlpListFormats({
        url,
        cookiesFromBrowser: onlineCookies?.value || "",
      });
      online.meta = meta;
      onlineTitle.textContent = meta.title || "(无标题)";
      const sub = [];
      if (meta.uploader) sub.push(meta.uploader);
      if (meta.duration) sub.push(formatDurationDisplay(meta.duration));
      if (meta.extractor) sub.push(meta.extractor);
      onlineSubtitle.textContent = sub.join(" · ");
      if (meta.thumbnail) {
        onlineThumb.src = meta.thumbnail;
        onlineThumb.hidden = false;
      } else {
        onlineThumb.removeAttribute("src");
        onlineThumb.hidden = true;
      }
      onlineMeta.hidden = false;
      onlineFormatsBox.hidden = false;
      renderFormats();
      onlineState.textContent = `共 ${meta.formats.length} 个格式可选`;
    } catch (error) {
      onlineState.textContent = `解析失败：${error.message}`;
    } finally {
      onlineFetch.disabled = false;
    }
  });
}

if (onlinePickOutput) {
  onlinePickOutput.addEventListener("click", async () => {
    const ext = chosenFormatExt();
    const stem = sanitizeFilename(online.meta?.title);
    const result = await window.videoFinder.dlpPickOutput({
      ext,
      suggestedName: `${stem}.${ext}`,
    });
    if (!result || result.canceled) return;
    online.output = result.filePath;
    onlineOutputName.textContent = result.filePath;
  });
}

if (onlineRun) {
  onlineRun.addEventListener("click", async () => {
    const url = onlineUrl.value.trim();
    if (!url) {
      onlineState.textContent = "请输入视频 URL";
      return;
    }
    if (!online.output) {
      onlineState.textContent = "请先选择保存位置";
      return;
    }
    setOnlineRunning(true);
    onlineState.textContent = "启动中";
    onlineProgress.style.width = "0%";
    onlineReveal.hidden = true;

    let format = "bv*+ba/b";
    if (online.selectedFormatId && online.selectedFormatId !== "auto") {
      format = online.selectedFormatId;
    }

    try {
      const result = await window.videoFinder.dlpDownload({
        url,
        format,
        output: online.output,
        cookiesFromBrowser: onlineCookies?.value || "",
        concurrency: Number(onlineConcurrency?.value) || 8,
      });
      onlineState.textContent = `完成${result.size ? ` · ${formatBytes(result.size)}` : ""}`;
      onlineProgress.style.width = "100%";
      online.output = result.filePath || online.output;
      onlineReveal.hidden = false;
    } catch (error) {
      onlineState.textContent = `失败：${error.message}`;
    } finally {
      setOnlineRunning(false);
    }
  });
}

if (onlineCancel) {
  onlineCancel.addEventListener("click", async () => {
    await window.videoFinder.dlpCancel();
    onlineState.textContent = "正在取消…";
  });
}

if (onlineReveal) {
  onlineReveal.addEventListener("click", async () => {
    if (online.output) await window.videoFinder.showFile(online.output);
  });
}

window.videoFinder.onDlpProgress((payload) => {
  if (payload.phase === "downloading") {
    if (typeof payload.percent === "number") {
      onlineProgress.style.width = `${Math.min(100, payload.percent)}%`;
    }
    const bits = [];
    bits.push(`下载 ${payload.percent?.toFixed?.(1) ?? "?"}%`);
    if (payload.speed) bits.push(payload.speed);
    if (payload.eta) bits.push(`ETA ${payload.eta}`);
    onlineState.textContent = bits.join(" · ");
  } else if (payload.phase === "merging") {
    onlineState.textContent = "合并中…";
  } else if (payload.phase === "post-processing") {
    onlineState.textContent = "后处理中…";
  }
});

window.videoFinder.onDlpStatus((payload) => {
  if (payload.state === "running") onlineState.textContent = "运行中";
  if (payload.state === "done") onlineState.textContent = "完成";
  if (payload.state === "error") onlineState.textContent = payload.message || "失败";
});

if (infoDropZone) {
  const onDragOver = (event) => {
    event.preventDefault();
    infoDropZone.classList.add("is-active");
  };
  const onDragLeave = () => infoDropZone.classList.remove("is-active");
  infoDropZone.addEventListener("dragover", onDragOver);
  infoDropZone.addEventListener("dragenter", onDragOver);
  infoDropZone.addEventListener("dragleave", onDragLeave);
  infoDropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    infoDropZone.classList.remove("is-active");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const filePath = window.videoFinder.pathForFile(file);
    if (!filePath) {
      infoState.textContent = "无法获取拖拽文件路径";
      return;
    }
    await probeAndRender(filePath);
  });
}
