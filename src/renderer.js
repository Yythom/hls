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

const scanView = document.querySelector("#scanView");
const navBack = document.querySelector("#navBack");
const navForward = document.querySelector("#navForward");
const navReload = document.querySelector("#navReload");
const navAddress = document.querySelector("#navAddress");

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
  scanning: false,
  logs: [],
};

const trimStateData = {
  input: null,
  output: null,
  duration: 0,
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
  const guideCount = document.querySelector("#guideCount");
  if (guideCount) guideCount.textContent = String(items.length);
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

let scanDownloadStatus = null;

async function startDownload(item) {
  scanDownloadStatus ||= createTaskStatus({ stateEl: downloadState, progressEl: progressBar });
  try {
    const result = await window.videoFinder.downloadPickOutput(item);
    if (!result || result.canceled) return;
    const [id] = await submitTasks([{ kind: "download", job: { item, output: result.filePath } }]);
    scanDownloadStatus.track(id);
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

// --- Embedded browser navigation bar ---------------------------------------
// The <webview> exposes goBack/goForward/reload/stop/loadURL/getURL directly in
// the renderer. Capture listeners (attached in the main process on scan start)
// persist across navigations, so back/forward/address-bar jumps keep capturing.
function webviewCanGo(direction) {
  const history = scanView.navigationHistory;
  try {
    if (history && typeof history.canGoBack === "function") {
      return direction === "back" ? history.canGoBack() : history.canGoForward();
    }
    return direction === "back" ? scanView.canGoBack() : scanView.canGoForward();
  } catch {
    return false;
  }
}

function currentWebviewUrl() {
  try {
    return scanView.getURL() || "";
  } catch {
    return "";
  }
}

function syncNav() {
  navBack.disabled = !webviewCanGo("back");
  navForward.disabled = !webviewCanGo("forward");
  const url = currentWebviewUrl();
  // Don't clobber the address while the user is editing it.
  if (url && url !== "about:blank" && document.activeElement !== navAddress) {
    navAddress.value = url;
  }
}

navBack.addEventListener("click", () => {
  if (webviewCanGo("back")) scanView.goBack();
});

navForward.addEventListener("click", () => {
  if (webviewCanGo("forward")) scanView.goForward();
});

navReload.addEventListener("click", () => {
  try {
    if (navReload.dataset.loading === "1") scanView.stop();
    else scanView.reload();
  } catch {
    // webview not ready yet — ignore.
  }
});

navAddress.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const value = navAddress.value.trim();
  if (!value) return;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    scanView.loadURL(url);
    scanView.blur();
  } catch (error) {
    scanStatus.textContent = `无法打开：${error.message}`;
  }
});

scanView.addEventListener("did-start-loading", () => {
  navReload.dataset.loading = "1";
  navReload.textContent = "✕";
  navReload.title = "停止加载";
});

scanView.addEventListener("did-stop-loading", () => {
  navReload.dataset.loading = "0";
  navReload.textContent = "⟳";
  navReload.title = "刷新";
  syncNav();
});

scanView.addEventListener("did-navigate", syncNav);
scanView.addEventListener("did-navigate-in-page", syncNav);

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
    scanStatus.textContent = "正在打开页面…";
    setScanning(true);
  } else if (status.state === "loaded") {
    scanStatus.textContent = "页面已加载 · 在下方登录并播放视频";
  } else if (status.state === "idle") {
    // The embedded webview keeps capturing — keep the scan "active" so the user
    // can log in / play the video, and can still click Stop.
    scanStatus.textContent = `已捕获 ${status.count || 0} 个 · 在下方播放视频以捕获 m3u8，完成后点停止`;
    setScanning(true);
  } else if (status.state === "stopped") {
    scanStatus.textContent = "已停止";
    setScanning(false);
  } else if (status.state === "error") {
    scanStatus.textContent = status.message;
    setScanning(false);
  }
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

const trimStatus = createTaskStatus({
  stateEl: trimState,
  progressEl: trimProgress,
  cancelBtn: trimCancel,
  revealBtn: trimReveal,
});

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
  trimStatus.reset();
  trimState.textContent = "Ready";
  trimProgress.style.width = "0%";
});

async function pickTrimOutput() {
  const suggested = suggestOutputName(trimInputName.textContent.split(" · ")[0]);
  const result = await window.videoFinder.trimPickOutput(suggested);
  if (!result || result.canceled) return false;
  trimStateData.output = result.filePath;
  trimOutputName.textContent = result.filePath;
  return true;
}

trimPickOutput.addEventListener("click", pickTrimOutput);

trimAddRange.addEventListener("click", () => addRangeRow());

trimRun.addEventListener("click", async () => {
  if (!trimStateData.input) {
    trimState.textContent = "Pick a source video first";
    return;
  }
  const ranges = getRanges();
  if (ranges.length === 0) {
    trimState.textContent = "Add at least one delete range";
    return;
  }
  if (!trimStateData.output && !(await pickTrimOutput())) {
    trimState.textContent = "Choose an output location first";
    return;
  }

  try {
    const [id] = await submitTasks([
      {
        kind: "trim",
        job: {
          input: trimStateData.input,
          output: trimStateData.output,
          ranges,
          mode: trimMode.value,
          duration: trimStateData.duration,
        },
      },
    ]);
    trimStatus.track(id, {
      formatDone: (task) => `Done · ${formatBytes(task.size)} · ${task.summary}`,
    });
    // The next run must pick its own file rather than overwrite this one.
    trimStateData.output = null;
    trimOutputName.textContent = "Not chosen";
  } catch (error) {
    trimState.textContent = `Failed: ${error.message}`;
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
  getOutputExt,
  getRunPayload,
  validate,
  formatDone = null,
  pickInputOptions = null,
}) {
  const tool = {
    input: null,
    inputName: null,
    inputSize: 0,
    output: null,
    duration: 0,
  };
  const status = createTaskStatus({ stateEl, progressEl, cancelBtn, revealBtn });

  if (pickInputBtn) {
    pickInputBtn.addEventListener("click", async () => {
      const result = await window.videoFinder.toolsPickFile(
        pickInputOptions || { title: "选择源视频" }
      );
      if (!result || result.canceled) return;
      const file = result.files?.[0];
      if (!file || file.error) {
        stateEl.textContent = file?.error || "读取失败";
        return;
      }
      tool.input = file.filePath;
      tool.inputName = file.fileName;
      tool.inputSize = file.size || 0;
      tool.duration = file.duration || 0;
      inputNameEl.textContent = `${file.fileName} · ${formatBytes(file.size)}${
        file.duration ? ` · ${formatDurationDisplay(file.duration)}` : ""
      }`;
      status.reset();
      stateEl.textContent = "Ready";
      progressEl.style.width = "0%";
    });
  }

  async function pickOutput() {
    const ext = typeof getOutputExt === "function" ? getOutputExt(tool) : "mp4";
    const stem = stemOf(tool.inputName) || `output-${Date.now()}`;
    const result = await window.videoFinder.toolsPickOutput({
      title: "保存输出",
      ext,
      suggestedName: `${stem}_${op}.${ext}`,
    });
    if (!result || result.canceled) return false;
    tool.output = result.filePath;
    outputNameEl.textContent = result.filePath;
    return true;
  }

  pickOutputBtn.addEventListener("click", pickOutput);

  runBtn.addEventListener("click", async () => {
    if (validate) {
      const err = validate(tool);
      if (err) {
        stateEl.textContent = err;
        return;
      }
    }
    if (!tool.output && !(await pickOutput())) {
      stateEl.textContent = "请先选择保存位置";
      return;
    }

    try {
      const [id] = await submitTasks([{ kind: "tool", job: getRunPayload(tool) }]);
      // formatDone may compare against the input as it was when submitted.
      const snapshot = { ...tool };
      status.track(id, {
        formatDone: formatDone ? (task) => formatDone(snapshot, task) : null,
      });
      // The next run must pick its own file rather than overwrite this one.
      tool.output = null;
      outputNameEl.textContent = "未选择";
    } catch (error) {
      stateEl.textContent = `失败：${error.message}`;
    }
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
// Video compress
// ─────────────────────────────────────────────────────────────────────────────

const compressMode = document.querySelector("#compressMode");
const compressQuality = document.querySelector("#compressQuality");
const compressTargetMb = document.querySelector("#compressTargetMb");
const compressCodec = document.querySelector("#compressCodec");
const compressScale = document.querySelector("#compressScale");
const compressCrf = document.querySelector("#compressCrf");
const compressCrfValue = document.querySelector("#compressCrfValue");
const compressFps = document.querySelector("#compressFps");
const compressPreset = document.querySelector("#compressPreset");
const compressAudio = document.querySelector("#compressAudio");
// Keep in sync with COMPRESS_CRF / COMPRESS_CRF_RANGE in tools.js.
const COMPRESS_CRF_UI = {
  h264: { min: 18, max: 35, medium: 27 },
  h265: { min: 20, max: 38, medium: 28 },
};
const compressState = document.querySelector("#compressState");
const compressProgress = document.querySelector("#compressProgress");

function syncCompressMode() {
  const bySize = compressMode.value === "size";
  document.querySelector("#compressQualityRow").hidden = bySize;
  document.querySelector("#compressSizeRow").hidden = !bySize;
  document.querySelector("#compressCrfRow").hidden = bySize || compressQuality.value !== "custom";
}

function syncCompressCrfRange() {
  const range = COMPRESS_CRF_UI[compressCodec.value] || COMPRESS_CRF_UI.h264;
  const current = Number(compressCrf.value);
  compressCrf.min = String(range.min);
  compressCrf.max = String(range.max);
  compressCrf.value = String(Math.min(range.max, Math.max(range.min, current || range.medium)));
  compressCrfValue.textContent = compressCrf.value;
}

compressMode.addEventListener("change", syncCompressMode);
compressQuality.addEventListener("change", syncCompressMode);
compressCodec.addEventListener("change", syncCompressCrfRange);
compressCrf.addEventListener("input", () => {
  compressCrfValue.textContent = compressCrf.value;
});
syncCompressMode();
syncCompressCrfRange();

makeTool({
  op: "compress",
  pickInputBtn: document.querySelector("#compressPickInput"),
  inputNameEl: document.querySelector("#compressInputName"),
  pickOutputBtn: document.querySelector("#compressPickOutput"),
  outputNameEl: document.querySelector("#compressOutputName"),
  runBtn: document.querySelector("#compressRun"),
  cancelBtn: document.querySelector("#compressCancel"),
  revealBtn: document.querySelector("#compressReveal"),
  stateEl: compressState,
  progressEl: compressProgress,
  getOutputExt: () => "mp4",
  validate: (t) => {
    if (!t.input) return "请先选择源视频";
    if (compressMode.value === "size" && !(Number(compressTargetMb.value) > 0)) return "请输入有效的目标大小";
    return null;
  },
  getRunPayload: (t) => ({
    op: "compress",
    input: t.input,
    output: t.output,
    options: {
      mode: compressMode.value,
      quality: compressQuality.value,
      crf: Number(compressCrf.value),
      targetMb: Number(compressTargetMb.value),
      codec: compressCodec.value,
      scale: compressScale.value,
      fps: compressFps.value,
      preset: compressPreset.value,
      audioKbps: Number(compressAudio.value),
    },
  }),
  formatDone: (t, result) => {
    const after = formatBytes(result.size);
    if (!t.inputSize) return `完成 · ${after}`;
    const ratio = Math.round((1 - result.size / t.inputSize) * 100);
    const summary = `完成 · ${formatBytes(t.inputSize)} → ${after}`;
    return ratio > 0 ? `${summary}（减小 ${ratio}%）` : `${summary}（未变小，可降低画质或分辨率）`;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Image convert / compress
// ─────────────────────────────────────────────────────────────────────────────

const imageFormat = document.querySelector("#imageFormat");
const imageQuality = document.querySelector("#imageQuality");
const imageQualityValue = document.querySelector("#imageQualityValue");
const imageResizeMode = document.querySelector("#imageResizeMode");
const imageWidth = document.querySelector("#imageWidth");
const imageStripMeta = document.querySelector("#imageStripMeta");
const imageState = document.querySelector("#imageState");
const imageProgress = document.querySelector("#imageProgress");

if (imageQuality && imageQualityValue) {
  imageQuality.addEventListener("input", () => {
    imageQualityValue.textContent = imageQuality.value;
  });
}

if (imageResizeMode && imageWidth) {
  imageResizeMode.addEventListener("change", () => {
    imageWidth.disabled = imageResizeMode.value !== "width";
  });
}

makeTool({
  op: "image",
  pickInputBtn: document.querySelector("#imagePickInput"),
  inputNameEl: document.querySelector("#imageInputName"),
  pickOutputBtn: document.querySelector("#imagePickOutput"),
  outputNameEl: document.querySelector("#imageOutputName"),
  runBtn: document.querySelector("#imageRun"),
  cancelBtn: document.querySelector("#imageCancel"),
  revealBtn: document.querySelector("#imageReveal"),
  stateEl: imageState,
  progressEl: imageProgress,
  pickInputOptions: {
    title: "选择源图片",
    kind: "image",
  },
  getOutputExt: () => imageFormat.value || "webp",
  validate: (t) => (t.input ? null : "请先选择源图片"),
  getRunPayload: (t) => ({
    op: "image",
    input: t.input,
    output: t.output,
    options: {
      format: imageFormat.value,
      quality: imageQuality.value,
      width: imageResizeMode.value === "width" ? imageWidth.value : "",
      stripMetadata: imageStripMeta.checked,
    },
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Watermark area processing
// ─────────────────────────────────────────────────────────────────────────────

const watermarkMode = document.querySelector("#watermarkMode");
const watermarkX = document.querySelector("#watermarkX");
const watermarkY = document.querySelector("#watermarkY");
const watermarkW = document.querySelector("#watermarkW");
const watermarkH = document.querySelector("#watermarkH");
const watermarkColor = document.querySelector("#watermarkColor");
const watermarkCropSide = document.querySelector("#watermarkCropSide");
const watermarkState = document.querySelector("#watermarkState");
const watermarkProgress = document.querySelector("#watermarkProgress");

function watermarkRegionError() {
  const nums = [watermarkX, watermarkY, watermarkW, watermarkH].map((el) => Number(el.value));
  if (nums.some((n) => !Number.isFinite(n))) return "请输入有效的区域数值";
  if (nums[0] < 0 || nums[1] < 0) return "X / Y 不能小于 0";
  if (nums[2] < 1 || nums[3] < 1) return "宽 / 高必须大于 0";
  return null;
}

makeTool({
  op: "watermark",
  pickInputBtn: document.querySelector("#watermarkPickInput"),
  inputNameEl: document.querySelector("#watermarkInputName"),
  pickOutputBtn: document.querySelector("#watermarkPickOutput"),
  outputNameEl: document.querySelector("#watermarkOutputName"),
  runBtn: document.querySelector("#watermarkRun"),
  cancelBtn: document.querySelector("#watermarkCancel"),
  revealBtn: document.querySelector("#watermarkReveal"),
  stateEl: watermarkState,
  progressEl: watermarkProgress,
  getOutputExt: () => "mp4",
  validate: (t) => {
    if (!t.input) return "请先选择源视频";
    return watermarkRegionError();
  },
  getRunPayload: (t) => ({
    op: "watermark",
    input: t.input,
    output: t.output,
    options: {
      mode: watermarkMode.value,
      x: watermarkX.value,
      y: watermarkY.value,
      width: watermarkW.value,
      height: watermarkH.value,
      color: watermarkColor.value,
      cropSide: watermarkCropSide.value,
    },
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

async function pickConcatOutput() {
  const result = await window.videoFinder.toolsPickOutput({
    title: "保存拼接结果",
    ext: "mp4",
    suggestedName: `concat-${Date.now()}.mp4`,
  });
  if (!result || result.canceled) return false;
  concatData.output = result.filePath;
  concatOutputName.textContent = result.filePath;
  return true;
}

concatPickOutput.addEventListener("click", pickConcatOutput);

const concatStatus = createTaskStatus({
  stateEl: concatState,
  progressEl: concatProgress,
  cancelBtn: concatCancel,
  revealBtn: concatReveal,
});

concatRun.addEventListener("click", async () => {
  if (concatData.files.length < 2) {
    concatState.textContent = "至少需要两个视频";
    return;
  }
  if (!concatData.output && !(await pickConcatOutput())) {
    concatState.textContent = "请先选择保存位置";
    return;
  }

  try {
    const [id] = await submitTasks([
      {
        kind: "tool",
        job: {
          op: "concat",
          inputs: concatData.files.map((f) => f.filePath),
          output: concatData.output,
          options: { mode: concatMode.value },
        },
      },
    ]);
    concatStatus.track(id);
    concatData.output = null;
    concatOutputName.textContent = "未选择";
  } catch (error) {
    concatState.textContent = `失败：${error.message}`;
  }
});

renderConcatList();

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
const onlineState = document.querySelector("#onlineState");
const onlineAsPlaylist = document.querySelector("#onlineAsPlaylist");
const onlinePlaylistBox = document.querySelector("#onlinePlaylistBox");
const onlinePlaylistTitle = document.querySelector("#onlinePlaylistTitle");
const onlinePlaylistCount = document.querySelector("#onlinePlaylistCount");
const onlinePlaylistEntries = document.querySelector("#onlinePlaylistEntries");
const onlinePlaylistAll = document.querySelector("#onlinePlaylistAll");
const onlinePlaylistNone = document.querySelector("#onlinePlaylistNone");
const onlinePlaylistQuality = document.querySelector("#onlinePlaylistQuality");
const onlinePickDir = document.querySelector("#onlinePickDir");
const onlineDirName = document.querySelector("#onlineDirName");
const onlineCookies = document.querySelector("#onlineCookies");
const onlineLogin = document.querySelector("#onlineLogin");
const onlineLoginClear = document.querySelector("#onlineLoginClear");
const onlineLoginState = document.querySelector("#onlineLoginState");
const onlineConcurrency = document.querySelector("#onlineConcurrency");
const ytdlpVersion = document.querySelector("#ytdlpVersion");
const ytdlpCheckUpdate = document.querySelector("#ytdlpCheckUpdate");
const ytdlpDoUpdate = document.querySelector("#ytdlpDoUpdate");
const ytdlpUpdateState = document.querySelector("#ytdlpUpdateState");

let ytdlpLatestTag = "";

async function refreshYtDlpVersion({ announceUpToDate = false } = {}) {
  if (!ytdlpVersion) return;
  ytdlpCheckUpdate.disabled = true;
  ytdlpUpdateState.textContent = "";
  ytdlpDoUpdate.hidden = true;
  try {
    const res = await window.videoFinder.dlpCheckUpdate();
    if (!res.ok) {
      ytdlpVersion.textContent = "版本: 未知";
      ytdlpUpdateState.textContent = `检查失败: ${res.error}`;
      return;
    }
    ytdlpVersion.textContent = `版本: ${res.current || "未知"}`;
    ytdlpLatestTag = res.latest || "";
    if (res.hasUpdate) {
      ytdlpDoUpdate.hidden = false;
      ytdlpDoUpdate.textContent = `更新到 ${res.latest}`;
      ytdlpUpdateState.textContent = "有新版本可用";
    } else if (announceUpToDate) {
      ytdlpUpdateState.textContent = "已是最新";
    }
  } catch (error) {
    ytdlpUpdateState.textContent = `检查失败: ${error.message}`;
  } finally {
    ytdlpCheckUpdate.disabled = false;
  }
}

if (ytdlpCheckUpdate) {
  ytdlpCheckUpdate.addEventListener("click", () => refreshYtDlpVersion({ announceUpToDate: true }));
}
if (ytdlpDoUpdate) {
  ytdlpDoUpdate.addEventListener("click", async () => {
    ytdlpDoUpdate.disabled = true;
    ytdlpCheckUpdate.disabled = true;
    ytdlpUpdateState.textContent = "准备下载…";
    const res = await window.videoFinder.dlpUpdate();
    ytdlpDoUpdate.disabled = false;
    ytdlpCheckUpdate.disabled = false;
    if (!res.ok) {
      ytdlpUpdateState.textContent = `更新失败: ${res.error}`;
      return;
    }
    ytdlpVersion.textContent = `版本: ${res.current || ytdlpLatestTag}`;
    ytdlpDoUpdate.hidden = true;
    ytdlpUpdateState.textContent = "更新完成";
  });
}
if (window.videoFinder.onDlpUpdateProgress) {
  window.videoFinder.onDlpUpdateProgress((payload) => {
    if (!ytdlpUpdateState) return;
    if (payload.phase === "download") {
      const pct = Math.round(payload.percent || 0);
      const mb = (payload.received / 1024 / 1024).toFixed(1);
      const totalMb = payload.total ? (payload.total / 1024 / 1024).toFixed(1) : "?";
      ytdlpUpdateState.textContent = `下载中 ${pct}%  (${mb}/${totalMb} MB)`;
    } else if (payload.phase === "install") {
      ytdlpUpdateState.textContent = "解压并验证新版本…（首次运行系统会做安全检查，约 10 秒）";
    } else if (payload.phase === "done") {
      ytdlpUpdateState.textContent = "更新完成";
    } else if (payload.phase === "error") {
      ytdlpUpdateState.textContent = `更新失败: ${payload.error}`;
    }
  });
}
// Lazy: check version on first switch to online tab (also runs once now).
refreshYtDlpVersion();

const online = {
  meta: null,
  // Set instead of `meta` when the URL resolved to a playlist.
  playlist: null,
  selectedFormatId: "auto",
  output: null,
  outputDir: null,
  // Netscape cookie jar produced by the in-app login window, plus the UA that
  // was used to obtain it (sites tie sessions to the UA).
  cookiesFile: "",
  cookiesUserAgent: "",
};

// The cookie-related args every yt-dlp call needs, for whichever source the
// user picked. Returns null when the user asked for the in-app login but has no
// session for *this* URL's site — running anonymously instead would fail in a
// confusing way on member-only videos. Re-reads the jar per call so switching
// the URL to another site can never reuse the previous site's cookies.
async function resolveCookieOptions(url) {
  const source = onlineCookies?.value || "";
  if (source !== "app-login") {
    return { cookiesFromBrowser: source, cookiesFile: "", userAgent: "" };
  }
  const res = await window.videoFinder.loginStatus(url);
  if (!res.ok || !res.loggedIn) {
    online.cookiesFile = "";
    online.cookiesUserAgent = "";
    onlineState.textContent = `请先点击「扫码登录」完成 ${res.name || "该站点"} 的登录`;
    return null;
  }
  online.cookiesFile = res.file;
  online.cookiesUserAgent = res.userAgent || "";
  return { cookiesFromBrowser: "", cookiesFile: res.file, userAgent: res.userAgent || "" };
}

const LOGIN_HINT = "B 站 1080P+ / 会员视频 必需。从所选浏览器读取登录态";
// Chromium 127+ on Windows encrypts cookies with a key yt-dlp cannot obtain.
const CHROMIUM_BROWSERS = new Set(["chrome", "edge", "chromium", "brave", "opera", "vivaldi"]);

// Reflect the saved session for the site in the URL box: whether the login
// buttons show at all, and whether we already have a usable cookie jar.
async function refreshLoginState() {
  if (!onlineLogin || !onlineLoginState) return;
  const appLogin = onlineCookies?.value === "app-login";
  onlineLogin.hidden = !appLogin;
  onlineLoginClear.hidden = true;
  if (!appLogin) {
    online.cookiesFile = "";
    online.cookiesUserAgent = "";
    const risky =
      navigator.userAgent.includes("Windows") && CHROMIUM_BROWSERS.has(onlineCookies?.value);
    onlineLoginState.textContent = risky
      ? "Windows 上 Chrome/Edge 的 Cookie 已被系统加密，yt-dlp 多半读不到——建议改选「应用内登录（扫码）」"
      : LOGIN_HINT;
    return;
  }

  const url = onlineUrl?.value.trim() || "";
  if (!url) {
    onlineLoginState.textContent = "请先填写视频 URL，再登录对应站点";
    return;
  }
  const res = await window.videoFinder.loginStatus(url);
  if (!res.ok) {
    onlineLoginState.textContent = res.error || "无法确定站点";
    return;
  }
  if (res.loggedIn) {
    online.cookiesFile = res.file;
    online.cookiesUserAgent = res.userAgent || "";
    onlineLoginClear.hidden = false;
    onlineLogin.textContent = "重新登录…";
    const when = res.updatedAt ? new Date(res.updatedAt).toLocaleString() : "";
    onlineLoginState.textContent = `已登录 ${res.name}（${res.count} 条 Cookie${when ? ` · ${when}` : ""}）`;
  } else {
    online.cookiesFile = "";
    online.cookiesUserAgent = "";
    onlineLogin.textContent = "扫码登录…";
    onlineLoginState.textContent = `未登录 ${res.name}，点击「扫码登录」在应用内登录一次`;
  }
}

if (onlineCookies) {
  onlineCookies.addEventListener("change", refreshLoginState);
}
if (onlineUrl) {
  onlineUrl.addEventListener("change", refreshLoginState);
}

if (onlineLogin) {
  onlineLogin.addEventListener("click", async () => {
    const url = onlineUrl?.value.trim() || "";
    if (!url) {
      onlineLoginState.textContent = "请先填写视频 URL";
      return;
    }
    onlineLogin.disabled = true;
    onlineLoginState.textContent = "已打开登录窗口，请扫码登录…";
    try {
      const res = await window.videoFinder.loginOpen(url);
      if (res.ok) {
        online.cookiesFile = res.file;
        online.cookiesUserAgent = res.userAgent || "";
        onlineLoginState.textContent = `已登录 ${res.name}（${res.count} 条 Cookie）`;
      } else {
        onlineLoginState.textContent = res.canceled
          ? "已取消登录（窗口被关闭）"
          : `登录未完成：${res.error || "未知原因"}`;
      }
    } catch (error) {
      onlineLoginState.textContent = `登录失败：${error.message}`;
    } finally {
      onlineLogin.disabled = false;
      await refreshLoginState();
    }
  });
}

if (onlineLoginClear) {
  onlineLoginClear.addEventListener("click", async () => {
    const url = onlineUrl?.value.trim() || "";
    if (!url) return;
    await window.videoFinder.loginClear(url);
    await refreshLoginState();
  });
}

function sanitizeFilename(name) {
  return (name || "video").replace(/[\/\\?%*:|"<>]/g, "_").slice(0, 120) || "video";
}

// When set, the "提取音频" option is selected; value is the target audio ext.
function chosenAudioFormat() {
  if (online.selectedFormatId !== "audio-extract") return "";
  return document.querySelector("#onlineAudioFormat")?.value || "mp3";
}

function chosenFormatExt() {
  const audio = chosenAudioFormat();
  if (audio) return audio;
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

  if (filter === "audio" || filter === "all") {
    const audio = document.createElement("label");
    audio.className = "online-format is-auto";
    audio.innerHTML = `
      <input type="radio" name="online-format" value="audio-extract" />
      <span class="online-format-main">
        <strong>提取音频并转换</strong>
        <span class="trim-muted">下载最佳音轨并转码，不含视频</span>
      </span>
      <select id="onlineAudioFormat" class="online-audio-format" aria-label="音频格式">
        <option value="mp3">MP3</option>
        <option value="m4a">M4A</option>
        <option value="flac">FLAC</option>
        <option value="wav">WAV</option>
      </select>
    `;
    rows.push(audio);
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
}

if (onlineKindFilter) {
  onlineKindFilter.addEventListener("change", renderFormats);
}

// Registered once: renderFormats runs on every parse / filter change.
onlineFormats?.addEventListener("change", (event) => {
  // Changing the embedded audio-format dropdown should also select its row.
  if (event.target?.id === "onlineAudioFormat") {
    const radio = onlineFormats.querySelector("input[value='audio-extract']");
    if (radio) radio.checked = true;
    online.selectedFormatId = "audio-extract";
  } else if (event.target?.name === "online-format") {
    online.selectedFormatId = event.target.value;
  } else {
    return;
  }
  // The chosen extension may have changed; a stale output path is now wrong.
  if (online.output) {
    online.output = null;
    onlineOutputName.textContent = "未选择";
  }
});

// Toggle the output controls between "save one file" and "save into a folder".
function setOnlineMode(mode) {
  const playlist = mode === "playlist";
  onlineMeta.hidden = mode !== "single";
  onlineFormatsBox.hidden = mode !== "single";
  onlinePlaylistBox.hidden = !playlist;
  onlinePickOutput.hidden = playlist;
  onlineOutputName.hidden = playlist;
  onlinePickDir.hidden = !playlist;
  onlineDirName.hidden = !playlist;
}

function showSingleMeta(meta) {
  online.meta = meta;
  online.playlist = null;
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
  setOnlineMode("single");
  renderFormats();
  onlineState.textContent = `共 ${meta.formats.length} 个格式可选`;
}

function playlistEntryTitle(entry) {
  return entry.title || `${online.playlist?.title || "视频"} P${entry.index}`;
}

function updatePlaylistCount() {
  const boxes = onlinePlaylistEntries.querySelectorAll("input[type='checkbox']");
  const checked = [...boxes].filter((b) => b.checked).length;
  onlinePlaylistCount.textContent = `已选 ${checked} / ${boxes.length}`;
}

function showPlaylist(playlist) {
  online.playlist = playlist;
  online.meta = null;
  onlinePlaylistTitle.textContent = playlist.title || "播放列表";
  const rows = playlist.entries.map((entry) => {
    const row = document.createElement("label");
    row.className = "online-format online-entry";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.value = String(entry.index);
    const index = document.createElement("span");
    index.className = "online-entry-index";
    index.textContent = `#${entry.index}`;
    const main = document.createElement("span");
    main.className = "online-format-main";
    const title = document.createElement("strong");
    title.textContent = entry.title || `P${entry.index}`;
    main.append(title);
    if (entry.uploader) {
      const sub = document.createElement("span");
      sub.className = "trim-muted";
      sub.textContent = entry.uploader;
      main.append(sub);
    }
    const dur = document.createElement("span");
    dur.className = "online-format-size trim-muted";
    dur.textContent = entry.duration ? formatDurationDisplay(entry.duration) : "";
    row.append(box, index, main, dur);
    return row;
  });
  onlinePlaylistEntries.replaceChildren(...rows);
  setOnlineMode("playlist");
  updatePlaylistCount();
  const noTitles = playlist.entries.every((e) => !e.title);
  onlineState.textContent =
    `共 ${playlist.entries.length} 项` + (noTitles ? "（该站点列表不含分集标题，文件名在下载时确定）" : "");
}

function setPlaylistChecked(checked) {
  onlinePlaylistEntries.querySelectorAll("input[type='checkbox']").forEach((b) => {
    b.checked = checked;
  });
  updatePlaylistCount();
}

onlinePlaylistEntries?.addEventListener("change", updatePlaylistCount);
onlinePlaylistAll?.addEventListener("click", () => setPlaylistChecked(true));
onlinePlaylistNone?.addEventListener("click", () => setPlaylistChecked(false));

if (onlineFetch) {
  onlineFetch.addEventListener("click", async () => {
    const url = onlineUrl.value.trim();
    if (!url) {
      onlineState.textContent = "请输入视频 URL";
      return;
    }
    const cookies = await resolveCookieOptions(url);
    if (!cookies) return;
    const asPlaylist = !!onlineAsPlaylist?.checked;
    onlineState.textContent = asPlaylist ? "解析列表中…" : "解析中…";
    setOnlineMode("none");
    online.meta = null;
    online.playlist = null;
    onlineFetch.disabled = true;
    try {
      const result = asPlaylist
        ? await window.videoFinder.dlpListPlaylist({ url, ...cookies })
        : await window.videoFinder.dlpListFormats({ url, ...cookies });
      if (result.isPlaylist) {
        if (result.entries.length === 0) throw new Error("列表为空");
        showPlaylist(result);
      } else {
        showSingleMeta(result);
      }
    } catch (error) {
      onlineState.textContent = `解析失败：${error.message}`;
    } finally {
      onlineFetch.disabled = false;
    }
  });
}

async function pickSingleOutput() {
  const ext = chosenFormatExt();
  const stem = sanitizeFilename(online.meta?.title);
  const result = await window.videoFinder.dlpPickOutput({
    ext,
    suggestedName: `${stem}.${ext}`,
  });
  if (!result || result.canceled) return false;
  online.output = result.filePath;
  onlineOutputName.textContent = result.filePath;
  return true;
}

async function pickPlaylistDir() {
  const result = await window.videoFinder.dlpPickDir();
  if (!result || result.canceled) return false;
  online.outputDir = result.dirPath;
  onlineDirName.textContent = result.dirPath;
  return true;
}

onlinePickOutput?.addEventListener("click", pickSingleOutput);
onlinePickDir?.addEventListener("click", pickPlaylistDir);

// Quality preset -> yt-dlp format selection for every playlist entry.
function playlistFormatOptions() {
  const q = onlinePlaylistQuality?.value || "best";
  if (q === "mp3" || q === "m4a") return { format: "", audioFormat: q };
  if (q === "best") return { format: "bv*+ba/b", audioFormat: "" };
  const h = Number(q);
  return { format: `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`, audioFormat: "" };
}

async function enqueuePlaylist(cookies) {
  const picked = new Set(
    [...onlinePlaylistEntries.querySelectorAll("input[type='checkbox']:checked")].map((b) => Number(b.value))
  );
  const entries = online.playlist.entries.filter((e) => picked.has(e.index));
  if (entries.length === 0) {
    onlineState.textContent = "请至少勾选一项";
    return;
  }
  if (!online.outputDir && !(await pickPlaylistDir())) {
    onlineState.textContent = "请先选择保存文件夹";
    return;
  }
  const pad = String(online.playlist.entries.length).length;
  const { format, audioFormat } = playlistFormatOptions();
  const concurrency = Number(onlineConcurrency?.value) || 8;
  const jobs = entries.map((entry) => ({
    title: playlistEntryTitle(entry),
    url: entry.url,
    playlistItem: entry.playlistItem || 0,
    outputDir: online.outputDir,
    // Index prefix keeps files in list order and avoids same-title collisions.
    namePrefix: `${String(entry.index).padStart(pad, "0")} - `,
    format,
    audioFormat,
    concurrency,
    ...cookies,
  }));
  const ids = await submitTasks(jobs.map((job) => ({ kind: "ytdlp", job })));
  onlineState.textContent = `已加入队列 ${ids.length} 项，右上角「任务」查看进度`;
}

async function enqueueSingle(url, cookies) {
  if (!online.meta) {
    onlineState.textContent = "请先点击「解析」";
    return;
  }
  if (!online.output && !(await pickSingleOutput())) {
    onlineState.textContent = "请先选择保存位置";
    return;
  }
  let format = "bv*+ba/b";
  if (
    online.selectedFormatId &&
    online.selectedFormatId !== "auto" &&
    online.selectedFormatId !== "audio-extract"
  ) {
    format = online.selectedFormatId;
  }
  await submitTasks([
    {
      kind: "ytdlp",
      job: {
        title: online.meta.title || url,
        url,
        format,
        audioFormat: chosenAudioFormat(),
        output: online.output,
        concurrency: Number(onlineConcurrency?.value) || 8,
        ...cookies,
      },
    },
  ]);
  onlineState.textContent = "已加入队列，右上角「任务」查看进度";
  // The next download must not silently overwrite this one's file.
  online.output = null;
  onlineOutputName.textContent = "未选择";
}

if (onlineRun) {
  onlineRun.addEventListener("click", async () => {
    const url = onlineUrl.value.trim();
    if (!url) {
      onlineState.textContent = "请输入视频 URL";
      return;
    }
    const cookies = await resolveCookieOptions(url);
    if (!cookies) return;
    onlineRun.disabled = true;
    try {
      if (online.playlist) await enqueuePlaylist(cookies);
      else await enqueueSingle(url, cookies);
    } catch (error) {
      onlineState.textContent = `加入队列失败：${ipcErrorMessage(error)}`;
    } finally {
      onlineRun.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Global task center: every download / yt-dlp / compress / convert / trim job
// runs through one queue in the main process. Pages submit tasks and mirror
// the progress of the one they submitted last; the drawer shows them all.
// ---------------------------------------------------------------------------

const taskToggle = document.querySelector("#taskToggle");
const taskBadge = document.querySelector("#taskBadge");
const taskDrawer = document.querySelector("#taskDrawer");
const taskBackdrop = document.querySelector("#taskBackdrop");
const taskClose = document.querySelector("#taskClose");
const taskSummary = document.querySelector("#taskSummary");
const taskListEl = document.querySelector("#taskList");
const taskLimitNetwork = document.querySelector("#taskLimitNetwork");
const taskLimitCpu = document.querySelector("#taskLimitCpu");
const taskCancelAll = document.querySelector("#taskCancelAll");
const taskClearDone = document.querySelector("#taskClearDone");

const taskEntries = new Map(); // id -> { task, el, actionsKey }
const taskWatchers = new Map(); // id -> Set<(task) => void>

const TASK_KIND_LABELS = { ytdlp: "在线", download: "下载", tool: "处理", trim: "裁剪" };

// ipcRenderer.invoke wraps main-process errors in a noisy prefix.
function ipcErrorMessage(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function describeTask(task) {
  switch (task.state) {
    case "queued":
      return "排队中…";
    case "running":
      return task.text || "进行中…";
    case "done":
      return ["完成", task.size ? formatBytes(task.size) : "", task.summary, task.filePath]
        .filter(Boolean)
        .join(" · ");
    case "error":
      return `失败：${task.error}`;
    case "canceled":
      return "已取消";
    default:
      return task.state;
  }
}

function taskButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function retryTask(id) {
  const res = await window.videoFinder.taskRetry(id);
  if (res && !res.ok && res.error) alert(res.error);
}

function renderTask(task) {
  let entry = taskEntries.get(task.id);
  if (!entry) {
    const el = document.createElement("div");
    el.innerHTML = `
      <div class="queue-item-title"><span class="queue-item-kind"></span><span></span></div>
      <div class="queue-item-actions"></div>
      <div class="queue-item-state"></div>
      <div class="progress"><div></div></div>
    `;
    entry = { task, el, actionsKey: "" };
    taskEntries.set(task.id, entry);
    // Newest first.
    taskListEl.prepend(el);
  }
  entry.task = task;
  const { el } = entry;
  el.className = `queue-item is-${task.state}`;
  el.querySelector(".queue-item-kind").textContent = TASK_KIND_LABELS[task.kind] || task.kind;
  const title = el.querySelector(".queue-item-title span:last-child");
  title.textContent = task.title;
  el.querySelector(".queue-item-title").title = task.title;
  el.querySelector(".queue-item-state").textContent = describeTask(task);
  if (typeof task.percent === "number" || task.state !== "running") {
    el.querySelector(".progress div").style.width = `${Math.min(100, task.percent || 0)}%`;
  }

  // Only rebuild buttons when the state changes, so a click isn't lost to a
  // progress update replacing the button under the cursor.
  if (entry.actionsKey !== task.state) {
    entry.actionsKey = task.state;
    const id = task.id;
    const actions = [];
    if (task.state === "queued" || task.state === "running") {
      actions.push(taskButton("取消", () => window.videoFinder.taskCancel(id)));
    }
    if (task.state === "error" || task.state === "canceled") {
      actions.push(taskButton("重试", () => retryTask(id)));
    }
    if (task.state === "done") {
      actions.push(taskButton("打开位置", () => window.videoFinder.showFile(task.filePath)));
    }
    if (task.state !== "running" && task.state !== "queued") {
      actions.push(taskButton("移除", () => window.videoFinder.taskRemove(id)));
    }
    el.querySelector(".queue-item-actions").replaceChildren(...actions);
  }
  updateTaskSummary();
}

function removeTaskEntry(id) {
  const entry = taskEntries.get(id);
  if (!entry) return;
  entry.el.remove();
  taskEntries.delete(id);
  taskWatchers.delete(id);
  updateTaskSummary();
}

function updateTaskSummary() {
  const counts = { queued: 0, running: 0, done: 0, error: 0 };
  for (const { task } of taskEntries.values()) {
    if (task.state in counts) counts[task.state]++;
  }
  const parts = [];
  if (counts.running) parts.push(`进行中 ${counts.running}`);
  if (counts.queued) parts.push(`排队 ${counts.queued}`);
  if (counts.done) parts.push(`完成 ${counts.done}`);
  if (counts.error) parts.push(`失败 ${counts.error}`);
  taskSummary.textContent = parts.length ? `· ${parts.join(" · ")}` : "";
  const active = counts.running + counts.queued;
  taskBadge.hidden = active === 0;
  taskBadge.textContent = String(active);
  const empty = taskListEl.querySelector(".queue-empty");
  if (empty) empty.hidden = taskEntries.size > 0;
}

function setTaskDrawerOpen(open) {
  taskDrawer.classList.toggle("is-open", open);
  taskDrawer.setAttribute("aria-hidden", String(!open));
  taskToggle.setAttribute("aria-expanded", String(open));
  taskBackdrop.hidden = !open;
}

taskToggle.addEventListener("click", () => setTaskDrawerOpen(!taskDrawer.classList.contains("is-open")));
taskClose.addEventListener("click", () => setTaskDrawerOpen(false));
taskBackdrop.addEventListener("click", () => setTaskDrawerOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && taskDrawer.classList.contains("is-open")) setTaskDrawerOpen(false);
});
taskCancelAll.addEventListener("click", () => window.videoFinder.taskCancelAll());
taskClearDone.addEventListener("click", () => window.videoFinder.taskClearFinished());

window.videoFinder.onTaskUpdate((payload) => {
  if (payload.type === "remove") {
    removeTaskEntry(payload.id);
    return;
  }
  renderTask(payload.task);
  taskWatchers.get(payload.task.id)?.forEach((fn) => fn(payload.task));
});

// entries: [{ kind, job }] -> task ids. Throws with a readable message.
async function submitTasks(entries) {
  try {
    const res = await window.videoFinder.taskAdd(entries);
    return res.ids;
  } catch (error) {
    throw new Error(ipcErrorMessage(error));
  }
}

function watchTask(id, fn) {
  if (!taskWatchers.has(id)) taskWatchers.set(id, new Set());
  taskWatchers.get(id).add(fn);
  const entry = taskEntries.get(id);
  if (entry) fn(entry.task);
}

// Mirror the latest task a page submitted into that page's own status line,
// progress bar and cancel / reveal buttons.
function createTaskStatus({ stateEl, progressEl, cancelBtn, revealBtn }) {
  let currentId = null;
  let currentTask = null;

  cancelBtn?.addEventListener("click", () => {
    if (currentId) window.videoFinder.taskCancel(currentId);
  });
  revealBtn?.addEventListener("click", () => {
    if (currentTask?.filePath) window.videoFinder.showFile(currentTask.filePath);
  });

  function show(task, formatDone) {
    currentTask = task;
    const active = task.state === "queued" || task.state === "running";
    if (cancelBtn) cancelBtn.disabled = !active;
    if (revealBtn) revealBtn.hidden = task.state !== "done";
    if (task.state === "queued") {
      stateEl.textContent = "已加入队列，排队中…（右上角「任务」可查看全部）";
      progressEl.style.width = "0%";
    } else if (task.state === "running") {
      stateEl.textContent = task.text || "进行中…";
      if (typeof task.percent === "number") progressEl.style.width = `${Math.min(100, task.percent)}%`;
    } else if (task.state === "done") {
      stateEl.textContent = formatDone ? formatDone(task) : `完成 · ${formatBytes(task.size)}`;
      progressEl.style.width = "100%";
    } else if (task.state === "error") {
      stateEl.textContent = `失败：${task.error}`;
    } else if (task.state === "canceled") {
      stateEl.textContent = "已取消";
    }
  }

  return {
    track(id, { formatDone } = {}) {
      currentId = id;
      watchTask(id, (task) => {
        if (id === currentId) show(task, formatDone);
      });
    },
    // The page reset (e.g. a new input was picked): stop mirroring.
    reset() {
      currentId = null;
      currentTask = null;
      if (cancelBtn) cancelBtn.disabled = true;
      if (revealBtn) revealBtn.hidden = true;
    },
  };
}

const TASK_LIMIT_KEY = "videoFinder.taskLimit.";
function initLaneLimit(select, lane) {
  if (!select) return;
  try {
    const stored = localStorage.getItem(TASK_LIMIT_KEY + lane);
    if (stored && [...select.options].some((o) => o.value === stored)) select.value = stored;
  } catch {
    /* preference only */
  }
  window.videoFinder.taskSetLimit(lane, Number(select.value));
  select.addEventListener("change", () => {
    try {
      localStorage.setItem(TASK_LIMIT_KEY + lane, select.value);
    } catch {
      /* preference only */
    }
    window.videoFinder.taskSetLimit(lane, Number(select.value));
  });
}
initLaneLimit(taskLimitNetwork, "network");
initLaneLimit(taskLimitCpu, "cpu");

// The queue lives in the main process; rebuild the view after a reload.
window.videoFinder.taskList().then(({ tasks }) => tasks.forEach(renderTask));

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
