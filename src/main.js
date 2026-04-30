const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

let mainWindow;
let scanWindow;
let scanMeta = null;
let activeScanSession = null;
const discovered = new Map();
const requestHeadersByUrl = new Map();

const VIDEO_EXTENSIONS = [
  "mp4",
  "webm",
  "m4v",
  "mov",
  "mkv",
  "avi",
  "flv",
  "m3u8",
  "mpd",
];

const VIDEO_CONTENT_TYPES = [
  "video/",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml",
];

const DOWNLOAD_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "origin",
  "referer",
  "user-agent",
]);

const HEADER_NAMES = {
  accept: "Accept",
  "accept-language": "Accept-Language",
  origin: "Origin",
  referer: "Referer",
  "user-agent": "User-Agent",
};

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

function pickDownloadHeaders(headers = {}) {
  const picked = {};

  Object.entries(headers).forEach(([key, value]) => {
    const normalized = key.toLowerCase();
    if (!DOWNLOAD_HEADER_ALLOWLIST.has(normalized)) return;
    if (typeof value !== "string") return;

    picked[HEADER_NAMES[normalized]] = value;
  });

  return picked;
}

function toHeaderValue(headers, name) {
  if (!headers) return "";
  const lowerName = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lowerName);
  const value = key ? headers[key] : "";
  if (Array.isArray(value)) return value.join("; ");
  return value || "";
}

function toHeaderNumber(headers, name) {
  const value = toHeaderValue(headers, name);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLikelyVideoResource(url, contentType = "") {
  const normalizedType = contentType.toLowerCase();
  const matchesContentType =
    normalizedType &&
    VIDEO_CONTENT_TYPES.some((type) => normalizedType.includes(type)) &&
    !normalizedType.includes("image/");

  if (matchesContentType && !/\.(js|css|json)(?:[?#]|$)/i.test(url)) {
    return true;
  }

  return new RegExp(`\\.(${VIDEO_EXTENSIONS.join("|")})(?:[?#]|$)`, "i").test(url);
}

function hashUrl(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function inferKind(url, contentType = "") {
  const lowerUrl = url.toLowerCase();
  const lowerType = contentType.toLowerCase();
  if (lowerUrl.includes(".m3u8") || lowerType.includes("mpegurl")) return "HLS";
  if (lowerUrl.includes(".mpd") || lowerType.includes("dash+xml")) return "DASH";
  if (lowerType.includes("video/")) return lowerType.split(";")[0].replace("video/", "").toUpperCase();
  const match = lowerUrl.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/);
  return match ? match[1].toUpperCase() : "VIDEO";
}

function fileNameFromUrl(url, fallbackExt = "mp4") {
  try {
    const parsed = new URL(url);
    const rawName = path.basename(parsed.pathname);
    const decoded = decodeURIComponent(rawName || "");
    const cleaned = decoded.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    if (cleaned && cleaned.includes(".")) return cleaned.slice(0, 140);
  } catch {
    // Fall through to generated name.
  }

  return `video-${Date.now()}.${fallbackExt}`;
}

function extensionForKind(kind) {
  if (kind === "HLS") return "m3u8";
  if (kind === "DASH") return "mpd";
  return kind && kind !== "VIDEO" ? kind.toLowerCase() : "mp4";
}

function isStreamItem(item) {
  return item.kind === "HLS" || item.kind === "DASH";
}

function isMp4Item(item, contentType = "") {
  return /\.mp4(?:[?#]|$)/i.test(item.url) || /video\/mp4/i.test(contentType);
}

function outputFileNameForCandidate(item) {
  const inputName = item.fileName || fileNameFromUrl(item.url);
  if (!isStreamItem(item)) return inputName;

  const parsed = path.parse(inputName);
  const baseName = parsed.name || `video-${Date.now()}`;
  return `${baseName}.mp4`;
}

function addCandidate(candidate) {
  if (!candidate.url || !isLikelyVideoResource(candidate.url, candidate.contentType)) return null;

  const existing = discovered.get(candidate.url);
  const merged = {
    id: hashUrl(candidate.url),
    url: candidate.url,
    pageUrl: scanMeta?.pageUrl || "",
    contentType: candidate.contentType || existing?.contentType || "",
    method: candidate.method || existing?.method || "GET",
    statusCode: candidate.statusCode || existing?.statusCode || 0,
    source: candidate.source || existing?.source || "network",
    kind: inferKind(candidate.url, candidate.contentType || existing?.contentType || ""),
    fileName: fileNameFromUrl(
      candidate.url,
      extensionForKind(inferKind(candidate.url, candidate.contentType || existing?.contentType || ""))
    ),
    size: candidate.size || existing?.size || 0,
    detectedAt: existing?.detectedAt || new Date().toISOString(),
  };

  discovered.set(candidate.url, merged);
  send("scan:candidate", merged);
  return merged;
}

async function collectDomCandidates() {
  if (!scanWindow || scanWindow.isDestroyed()) return;

  try {
    const urls = await scanWindow.webContents.executeJavaScript(`
      (() => {
        const values = new Set();
        const push = (value) => {
          if (typeof value === "string" && /^https?:\\/\\//i.test(value)) values.add(value);
        };
        document.querySelectorAll("video, source").forEach((node) => {
          push(node.currentSrc);
          push(node.src);
        });
        document.querySelectorAll("a[href]").forEach((node) => push(node.href));
        performance.getEntriesByType("resource").forEach((entry) => push(entry.name));
        return Array.from(values);
      })();
    `);

    urls.forEach((url) => addCandidate({ url, source: "page" }));
  } catch (error) {
    send("scan:log", { level: "warn", message: `DOM scan skipped: ${error.message}` });
  }
}

function closeScanWindow() {
  if (scanWindow && !scanWindow.isDestroyed()) {
    scanWindow.close();
  }
  scanWindow = null;
  scanMeta = null;
  activeScanSession = null;
  requestHeadersByUrl.clear();
  logEvent("info", "Closed scan window");
}

function normalizePageUrl(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Please enter a URL.");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS pages are supported.");
  }
  return parsed.toString();
}

async function startScan(rawUrl) {
  const pageUrl = normalizePageUrl(rawUrl);
  closeScanWindow();
  discovered.clear();
  scanMeta = { pageUrl, startedAt: Date.now() };
  logEvent("info", "Starting scan", { pageUrl });

  scanWindow = new BrowserWindow({
    width: 1366,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `persist:video-scan-${Date.now()}`,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });

  scanWindow.webContents.setAudioMuted(true);

  const webContentsId = scanWindow.webContents.id;
  const scanSession = scanWindow.webContents.session;
  activeScanSession = scanSession;
  const filter = { urls: ["http://*/*", "https://*/*"] };

  scanSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (details.webContentsId === webContentsId) {
      requestHeadersByUrl.set(details.url, pickDownloadHeaders(details.requestHeaders));
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  scanSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    if (details.webContentsId === webContentsId) {
      addCandidate({ url: details.url, method: details.method, source: "request" });
    }
    callback({ cancel: false });
  });

  scanSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (details.webContentsId === webContentsId) {
      addCandidate({
        url: details.url,
        method: details.method,
        contentType: toHeaderValue(details.responseHeaders, "content-type"),
        size: toHeaderNumber(details.responseHeaders, "content-length"),
        statusCode: details.statusCode,
        source: "network",
      });
    }
    callback({ responseHeaders: details.responseHeaders });
  });

  scanWindow.webContents.on("did-finish-load", async () => {
    send("scan:status", { state: "loaded", pageUrl });
    logEvent("info", "Page loaded", { pageUrl });
    await collectDomCandidates();
    setTimeout(collectDomCandidates, 2500);
    setTimeout(collectDomCandidates, 8000);
  });

  scanWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL === pageUrl) {
      send("scan:status", { state: "error", pageUrl, message: `${errorCode}: ${errorDescription}` });
      logEvent("error", "Page load failed", { pageUrl, errorCode, errorDescription });
    }
  });

  scanWindow.on("closed", () => {
    scanWindow = null;
  });

  send("scan:status", { state: "loading", pageUrl });
  await scanWindow.loadURL(pageUrl);

  setTimeout(() => {
    send("scan:status", {
      state: "idle",
      pageUrl,
      count: discovered.size,
    });
    logEvent("info", "Scan finished", { pageUrl, count: discovered.size });
  }, 9000);

  return { pageUrl };
}

async function cookieHeaderForItem(item) {
  if (!activeScanSession || !item.url) return "";

  try {
    const cookies = await activeScanSession.cookies.get({ url: item.url });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return "";
  }
}

async function makeDownloadHeaders(item) {
  const browserHeaders = requestHeadersByUrl.get(item.url) || {};
  const headers = {
    ...browserHeaders,
    "User-Agent": browserHeaders["User-Agent"] ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: browserHeaders.Accept || "*/*",
  };

  if (item.pageUrl) {
    headers.Referer = item.pageUrl;
  }

  const cookie = await cookieHeaderForItem(item);
  if (cookie) {
    headers.Cookie = cookie;
  }

  logEvent("debug", "Prepared download headers", {
    url: item.url,
    headers: Object.keys(headers),
    hasCookie: Boolean(cookie),
  });

  return headers;
}

const DOWNLOAD_SEGMENT_SIZE = 4 * 1024 * 1024;
const DOWNLOAD_MAX_PARALLEL = 4;
const DOWNLOAD_MAX_RETRIES = 5;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeResource(item, baseHeaders) {
  try {
    const head = await fetch(item.url, {
      method: "HEAD",
      redirect: "follow",
      headers: baseHeaders,
    });
    if (head.ok) {
      const len = Number(head.headers.get("content-length")) || 0;
      const acceptRanges = (head.headers.get("accept-ranges") || "").toLowerCase();
      return {
        totalSize: len,
        acceptsRanges: acceptRanges.includes("bytes") && len > 0,
        contentType: head.headers.get("content-type") || "",
      };
    }
  } catch (error) {
    logEvent("debug", "HEAD probe failed, falling back to Range probe", {
      url: item.url,
      error: error.message,
    });
  }

  const probe = await fetch(item.url, {
    redirect: "follow",
    headers: { ...baseHeaders, Range: "bytes=0-0" },
  });
  if (probe.status === 206) {
    const cr = probe.headers.get("content-range") || "";
    const match = cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
    const total = match ? Number(match[1]) : 0;
    try {
      await probe.body?.cancel?.();
    } catch {
      /* ignore */
    }
    return {
      totalSize: total,
      acceptsRanges: total > 0,
      contentType: probe.headers.get("content-type") || "",
    };
  }
  if (!probe.ok) {
    throw new Error(`Download failed with HTTP ${probe.status}.`);
  }
  const len = Number(probe.headers.get("content-length")) || 0;
  try {
    await probe.body?.cancel?.();
  } catch {
    /* ignore */
  }
  return {
    totalSize: len,
    acceptsRanges: false,
    contentType: probe.headers.get("content-type") || "",
  };
}

async function downloadSegmentWithRetry(item, fd, seg, baseHeaders, onProgress) {
  for (let attempt = 0; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    const rangeStart = seg.start + seg.downloaded;
    if (rangeStart > seg.end) return;

    try {
      const res = await fetch(item.url, {
        redirect: "follow",
        headers: { ...baseHeaders, Range: `bytes=${rangeStart}-${seg.end}` },
      });
      if (res.status !== 206) {
        throw new Error(`Range not honored, status ${res.status}`);
      }
      if (!res.body) throw new Error("No response body for range request");

      const reader = res.body.getReader();
      let writeOffset = rangeStart;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        await fd.write(value, 0, value.length, writeOffset);
        writeOffset += value.length;
        seg.downloaded += value.length;
        onProgress(value.length);
      }

      const expected = seg.end - seg.start + 1;
      if (seg.downloaded < expected) {
        throw new Error(`Segment incomplete: ${seg.downloaded}/${expected}`);
      }
      return;
    } catch (error) {
      if (attempt === DOWNLOAD_MAX_RETRIES) throw error;
      logEvent("warn", "Segment retrying", {
        url: item.url,
        segment: `${seg.start}-${seg.end}`,
        downloaded: seg.downloaded,
        attempt: attempt + 1,
        error: error.message,
      });
      await delay(400 * Math.pow(2, attempt));
    }
  }
}

async function downloadWithRanges(item, filePath, total, baseHeaders, onProgress) {
  const fd = await fs.promises.open(filePath, "w");
  try {
    await fd.truncate(total);

    const segments = [];
    for (let start = 0; start < total; start += DOWNLOAD_SEGMENT_SIZE) {
      const end = Math.min(start + DOWNLOAD_SEGMENT_SIZE - 1, total - 1);
      segments.push({ start, end, downloaded: 0 });
    }

    let receivedTotal = 0;
    let nextIndex = 0;
    const concurrency = Math.min(DOWNLOAD_MAX_PARALLEL, segments.length);

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= segments.length) return;
        await downloadSegmentWithRetry(item, fd, segments[idx], baseHeaders, (delta) => {
          receivedTotal += delta;
          onProgress(receivedTotal);
        });
      }
    });

    await Promise.all(workers);
    await fd.sync();
    return receivedTotal;
  } finally {
    await fd.close();
  }
}

async function downloadSingleStream(item, filePath, baseHeaders, onProgress) {
  let lastError;
  for (let attempt = 0; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(item.url, { redirect: "follow", headers: baseHeaders });
      if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}.`);

      const total = Number(res.headers.get("content-length")) || 0;
      const body = Readable.fromWeb(res.body);
      let received = 0;
      body.on("data", (chunk) => {
        received += chunk.length;
        onProgress(received, total);
      });

      await pipeline(body, fs.createWriteStream(filePath));

      if (total > 0 && received !== total) {
        throw new Error(`Truncated: received ${received}/${total} bytes`);
      }
      return { received, total };
    } catch (error) {
      lastError = error;
      if (attempt === DOWNLOAD_MAX_RETRIES) break;
      logEvent("warn", "Single-stream retry", {
        url: item.url,
        attempt: attempt + 1,
        error: error.message,
      });
      await delay(400 * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

async function topUpFile(item, filePath, fromOffset, lastByte, baseHeaders) {
  const fd = await fs.promises.open(filePath, "r+");
  try {
    const seg = { start: fromOffset, end: lastByte, downloaded: 0 };
    await downloadSegmentWithRetry(item, fd, seg, baseHeaders, () => {});
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function downloadCandidate(item, filePath) {
  logEvent("info", "Starting HTTP download", {
    url: item.url,
    filePath,
    kind: item.kind,
  });

  const baseHeaders = await makeDownloadHeaders(item);
  const probe = await probeResource(item, baseHeaders);

  logEvent("info", "Probe result", {
    url: item.url,
    totalSize: probe.totalSize,
    acceptsRanges: probe.acceptsRanges,
    contentType: probe.contentType,
  });

  if (!isLikelyVideoResource(item.url, probe.contentType)) {
    throw new Error(
      `The server returned ${probe.contentType || "unknown content"} instead of a video. This is usually an auth, anti-hotlink, or expired URL response.`
    );
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  let total = probe.totalSize;
  let received = 0;

  try {
    if (probe.acceptsRanges && probe.totalSize > 0) {
      logEvent("info", "Downloading via parallel ranges", {
        totalSize: probe.totalSize,
        segments: Math.ceil(probe.totalSize / DOWNLOAD_SEGMENT_SIZE),
        parallel: DOWNLOAD_MAX_PARALLEL,
      });
      received = await downloadWithRanges(
        item,
        filePath,
        probe.totalSize,
        baseHeaders,
        (r) => {
          send("download:progress", { id: item.id, received: r, total, filePath });
        }
      );
    } else {
      logEvent("info", "Downloading via single stream (range not supported)");
      const result = await downloadSingleStream(item, filePath, baseHeaders, (r, t) => {
        if (t && !total) total = t;
        send("download:progress", { id: item.id, received: r, total, filePath });
      });
      received = result.received;
      if (result.total) total = result.total;
    }

    if (total > 0) {
      let stat = await fs.promises.stat(filePath);
      if (stat.size < total && probe.acceptsRanges) {
        logEvent("warn", "File short after download, topping up via range", {
          filePath,
          size: stat.size,
          expected: total,
        });
        await topUpFile(item, filePath, stat.size, total - 1, baseHeaders);
        stat = await fs.promises.stat(filePath);
      }
      if (stat.size !== total) {
        throw new Error(
          `Incomplete download: received ${stat.size} bytes, expected ${total} bytes. Please try again.`
        );
      }
      received = stat.size;
    }
  } catch (error) {
    await fs.promises.rm(filePath, { force: true });
    throw error;
  }

  logEvent("info", "HTTP download completed", { filePath, received, expected: total });

  try {
    const validation = await validateDownloadedFile(item, filePath, {
      expectedSize: total,
      actualSize: received,
      contentType: probe.contentType,
    });

    if (validation.canRemux) {
      send("download:status", { id: item.id, state: "repairing", filePath });
      logEvent("info", "Remuxing MP4", { filePath });
      await remuxMp4File(item, filePath);
      await validateDownloadedFile(item, filePath, {
        expectedSize: 0,
        actualSize: 0,
        contentType: probe.contentType,
      });
    }
  } catch (error) {
    logEvent("error", "Download validation or repair failed", {
      filePath,
      error: error.message,
    });
    await fs.promises.rm(filePath, { force: true });
    throw error;
  }

  logEvent("info", "Download ready", { filePath });
  return { id: item.id, filePath, received, total };
}

async function validateDownloadedFile(item, filePath, { expectedSize, actualSize, contentType }) {
  logEvent("debug", "Validating downloaded file", {
    filePath,
    expectedSize,
    actualSize,
    contentType,
  });

  if (expectedSize > 0 && actualSize !== expectedSize) {
    throw new Error(
      `Incomplete download: received ${actualSize} bytes, expected ${expectedSize} bytes. Please try again.`
    );
  }

  if (!isMp4Item(item, contentType)) return { canRemux: false };

  const handle = await fs.promises.open(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const hasFtyp = bytesRead >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp";
    if (!hasFtyp) {
      logEvent("warn", "Downloaded file does not look like a standard MP4", {
        filePath,
        note: "The file was kept, but common players may not open it.",
      });
      return { canRemux: false };
    }
    logEvent("debug", "MP4 header validated", { filePath });
    return { canRemux: true };
  } finally {
    await handle.close();
  }
}

let cachedFfmpegPath;
function ffmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  if (process.env.FFMPEG_PATH) {
    cachedFfmpegPath = process.env.FFMPEG_PATH;
    return cachedFfmpegPath;
  }

  if (app.isPackaged) {
    const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const resourcePath = path.join(process.resourcesPath, exe);
    if (fs.existsSync(resourcePath)) {
      cachedFfmpegPath = resourcePath;
      return cachedFfmpegPath;
    }
    logEvent("warn", "Bundled ffmpeg not found in resources, falling back", {
      tried: resourcePath,
    });
  }

  try {
    const bundled = require("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) {
      cachedFfmpegPath = bundled;
      return cachedFfmpegPath;
    }
  } catch (error) {
    logEvent("debug", "ffmpeg-static unavailable in dev", { error: error.message });
  }

  cachedFfmpegPath = "ffmpeg";
  return cachedFfmpegPath;
}

function safeFfmpegArgs(args) {
  return args.map((arg, index) => (args[index - 1] === "-headers" ? "[redacted headers]" : arg));
}

async function remuxMp4File(item, filePath) {
  const parsed = path.parse(filePath);
  const tempPath = path.join(parsed.dir, `.${parsed.name}-${process.pid}-${Date.now()}.remux.mp4`);

  try {
    const result = await runFfmpeg(
      [
        "-hide_banner",
        "-y",
        "-nostats",
        "-i",
        filePath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        tempPath,
      ],
      item,
      {
        filePath,
        mode: "remux",
        missingFfmpegIsFatal: false,
      }
    );

    if (result.skipped) return;
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

function runFfmpeg(args, item, options) {
  return new Promise((resolve, reject) => {
    logEvent("debug", "Running ffmpeg", {
      mode: options.mode,
      args: safeFfmpegArgs(args),
    });

    const child = spawn(ffmpegPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let outTimeMs = 0;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const match = text.match(/out_time_ms=(\d+)/);
      if (match) outTimeMs = Number(match[1]);
      send("download:progress", {
        id: item.id,
        received: outTimeMs,
        total: 0,
        filePath: options.filePath,
        mode: options.mode,
      });
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT" && !options.missingFfmpegIsFatal) {
        logEvent("warn", "ffmpeg not found; skipped optional MP4 remux", {
          mode: options.mode,
        });
        resolve({ skipped: true });
        return;
      }

      if (error.code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH."));
      } else {
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        logEvent("info", "ffmpeg completed", {
          mode: options.mode,
          filePath: options.filePath,
        });
        resolve({ outTimeMs });
      } else {
        const detail = stderr.split("\n").filter(Boolean).slice(-4).join(" ");
        logEvent("error", "ffmpeg failed", {
          mode: options.mode,
          code,
          detail,
        });
        reject(new Error(detail || `ffmpeg exited with code ${code}.`));
      }
    });
  });
}

async function ffmpegHeaders(item) {
  const headers = await makeDownloadHeaders(item);
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n")}\r\n`;
}

async function downloadStreamCandidate(item, filePath) {
  if (item.kind === "HLS") return downloadHlsCandidate(item, filePath);
  return downloadFfmpegStream(item, filePath);
}

async function downloadFfmpegStream(item, filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const headerText = await ffmpegHeaders(item);
  logEvent("info", "Starting stream download through ffmpeg", {
    url: item.url,
    filePath,
    kind: item.kind,
  });

  const result = await runFfmpeg(
    [
      "-hide_banner",
      "-y",
      "-nostats",
      "-progress",
      "pipe:1",
      "-rw_timeout",
      "20000000",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_at_eof",
      "1",
      "-reconnect_delay_max",
      "5",
      "-allowed_extensions",
      "ALL",
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto,data",
      "-headers",
      headerText,
      "-i",
      item.url,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      filePath,
    ],
    item,
    {
      filePath,
      mode: "stream",
      missingFfmpegIsFatal: true,
    }
  );

  return { id: item.id, filePath, received: result.outTimeMs || 0, total: 0 };
}

const HLS_MAX_PARALLEL = 6;
const HLS_KEY_FETCH_RETRIES = 5;

function parseAttrList(input) {
  const result = {};
  let i = 0;
  while (i < input.length) {
    while (i < input.length && input[i] === " ") i++;
    const keyStart = i;
    while (i < input.length && input[i] !== "=") i++;
    const key = input.slice(keyStart, i).trim();
    if (input[i] === "=") i++;
    let value = "";
    if (input[i] === '"') {
      i++;
      const start = i;
      while (i < input.length && input[i] !== '"') i++;
      value = input.slice(start, i);
      if (input[i] === '"') i++;
    } else {
      const start = i;
      while (i < input.length && input[i] !== ",") i++;
      value = input.slice(start, i);
    }
    if (key) result[key] = value;
    if (input[i] === ",") i++;
  }
  return result;
}

function hexToBuffer(hex) {
  const cleaned = /^0x/i.test(hex) ? hex.slice(2) : hex;
  return Buffer.from(cleaned, "hex");
}

function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.trim().startsWith("#EXTM3U")) {
    throw new Error("Not a valid M3U8 playlist (missing #EXTM3U header).");
  }

  const variants = [];
  const segments = [];
  let mediaSequence = 0;
  let currentKey = null;
  let pendingDuration = 0;
  let pendingByterange = null;
  let pendingStreamInf = null;
  let lastByterangeOffset = 0;
  let hasMap = false;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-KEY:".length));
      if (!attrs.METHOD || attrs.METHOD === "NONE") {
        currentKey = null;
      } else if (attrs.METHOD === "AES-128") {
        currentKey = {
          method: "AES-128",
          uri: new URL(attrs.URI, baseUrl).toString(),
          iv: attrs.IV ? hexToBuffer(attrs.IV) : null,
          format: attrs.KEYFORMAT || "identity",
        };
        if (currentKey.format !== "identity") {
          throw new Error(`Unsupported HLS KEYFORMAT: ${currentKey.format}`);
        }
      } else {
        throw new Error(`Unsupported HLS encryption method: ${attrs.METHOD}`);
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      hasMap = true;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const spec = line.slice("#EXT-X-BYTERANGE:".length);
      const [lenStr, offStr] = spec.split("@");
      const length = Number(lenStr) || 0;
      const offset = offStr !== undefined ? Number(offStr) : lastByterangeOffset;
      pendingByterange = { length, offset };
      lastByterangeOffset = offset + length;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice("#EXTINF:".length).split(",")[0]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-STREAM-INF:".length));
      pendingStreamInf = {
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        resolution: attrs.RESOLUTION || "",
        codecs: attrs.CODECS || "",
      };
      continue;
    }
    if (line.startsWith("#")) continue;

    const absoluteUrl = new URL(line, baseUrl).toString();
    if (pendingStreamInf) {
      variants.push({ ...pendingStreamInf, url: absoluteUrl });
      pendingStreamInf = null;
    } else {
      segments.push({
        url: absoluteUrl,
        duration: pendingDuration,
        byterange: pendingByterange,
        key: currentKey,
        sequence: mediaSequence + segments.length,
      });
      pendingDuration = 0;
      pendingByterange = null;
    }
  }

  return { variants, segments, hasMap };
}

function ivForSegment(segment) {
  if (segment.key?.iv) return segment.key.iv;
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(segment.sequence), 8);
  return iv;
}

async function fetchAsBuffer(url, headers) {
  const res = await fetch(url, { redirect: "follow", headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchAsBufferWithRetry(url, headers, retries = DOWNLOAD_MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchAsBuffer(url, headers);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await delay(400 * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

async function fetchAsText(url, headers) {
  const res = await fetch(url, { redirect: "follow", headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return await res.text();
}

async function loadHlsKey(keyMeta, baseHeaders, keyCache) {
  if (!keyMeta) return null;
  if (keyCache.has(keyMeta.uri)) return keyCache.get(keyMeta.uri);
  const bytes = await fetchAsBufferWithRetry(keyMeta.uri, baseHeaders, HLS_KEY_FETCH_RETRIES);
  if (bytes.length !== 16) {
    throw new Error(`Invalid AES-128 key length: ${bytes.length} (expected 16) at ${keyMeta.uri}`);
  }
  keyCache.set(keyMeta.uri, bytes);
  return bytes;
}

async function downloadHlsSegment(segment, segPath, baseHeaders, keyCache) {
  const keyData = await loadHlsKey(segment.key, baseHeaders, keyCache);

  const segHeaders = { ...baseHeaders };
  if (segment.byterange) {
    const start = segment.byterange.offset;
    const end = start + segment.byterange.length - 1;
    segHeaders.Range = `bytes=${start}-${end}`;
  }

  let lastError;
  for (let attempt = 0; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const encrypted = await fetchAsBuffer(segment.url, segHeaders);
      const plain = keyData
        ? (() => {
            const decipher = crypto.createDecipheriv("aes-128-cbc", keyData, ivForSegment(segment));
            return Buffer.concat([decipher.update(encrypted), decipher.final()]);
          })()
        : encrypted;
      await fs.promises.writeFile(segPath, plain);
      return plain.length;
    } catch (error) {
      lastError = error;
      if (attempt === DOWNLOAD_MAX_RETRIES) break;
      logEvent("warn", "HLS segment retrying", {
        url: segment.url,
        sequence: segment.sequence,
        attempt: attempt + 1,
        error: error.message,
      });
      await delay(400 * Math.pow(2, attempt));
    }
  }
  throw new Error(`Segment ${segment.sequence} failed: ${lastError.message}`);
}

async function concatTsFiles(segmentPaths, outputPath) {
  const out = fs.createWriteStream(outputPath);
  try {
    for (const p of segmentPaths) {
      await new Promise((resolve, reject) => {
        const src = fs.createReadStream(p);
        src.on("error", reject);
        src.on("end", resolve);
        out.on("error", reject);
        src.pipe(out, { end: false });
      });
    }
  } finally {
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
  }
}

async function downloadHlsCandidate(item, filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const baseHeaders = await makeDownloadHeaders(item);

  logEvent("info", "Starting HLS download", { url: item.url, filePath });

  let playlistText = await fetchAsText(item.url, baseHeaders);
  let playlist = parseM3u8(playlistText, item.url);

  if (playlist.variants.length > 0 && playlist.segments.length === 0) {
    const best = [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    logEvent("info", "Picked HLS variant", {
      bandwidth: best.bandwidth,
      resolution: best.resolution,
      codecs: best.codecs,
    });
    playlistText = await fetchAsText(best.url, baseHeaders);
    playlist = parseM3u8(playlistText, best.url);
  }

  if (playlist.segments.length === 0) {
    throw new Error("HLS playlist has no segments.");
  }
  if (playlist.hasMap) {
    throw new Error(
      "HLS playlist uses #EXT-X-MAP (fMP4 init segments). This format is not yet supported."
    );
  }

  const totalSegments = playlist.segments.length;
  const totalDuration = playlist.segments.reduce((acc, s) => acc + (s.duration || 0), 0);
  logEvent("info", "HLS playlist parsed", {
    segments: totalSegments,
    durationSeconds: Math.round(totalDuration),
    encrypted: playlist.segments.some((s) => s.key),
  });

  const tempDir = `${filePath}.hls-tmp`;
  await fs.promises.rm(tempDir, { recursive: true, force: true });
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    const segmentPaths = new Array(totalSegments);
    const keyCache = new Map();
    let doneCount = 0;
    let receivedBytes = 0;
    let nextIndex = 0;

    const concurrency = Math.min(HLS_MAX_PARALLEL, totalSegments);
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= totalSegments) return;
        const segment = playlist.segments[idx];
        const segPath = path.join(tempDir, `seg_${String(idx).padStart(6, "0")}.ts`);
        const bytes = await downloadHlsSegment(segment, segPath, baseHeaders, keyCache);
        segmentPaths[idx] = segPath;
        doneCount++;
        receivedBytes += bytes;
        send("download:progress", {
          id: item.id,
          mode: "hls-segments",
          received: doneCount,
          total: totalSegments,
          bytes: receivedBytes,
          filePath,
        });
      }
    });

    await Promise.all(workers);
    logEvent("info", "All HLS segments downloaded", {
      segments: totalSegments,
      bytes: receivedBytes,
    });

    send("download:progress", {
      id: item.id,
      mode: "hls-merging",
      received: 0,
      total: 0,
      filePath,
    });
    const concatPath = path.join(tempDir, "all.ts");
    await concatTsFiles(segmentPaths, concatPath);
    logEvent("info", "Concatenated HLS segments", { concatPath });

    send("download:status", { id: item.id, state: "repairing", filePath });
    await runFfmpeg(
      [
        "-hide_banner",
        "-y",
        "-nostats",
        "-i",
        concatPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-bsf:a",
        "aac_adtstoasc",
        filePath,
      ],
      item,
      { filePath, mode: "remux", missingFfmpegIsFatal: true }
    );

    const stat = await fs.promises.stat(filePath);
    if (stat.size < 1024) {
      throw new Error(`Output file looks too small (${stat.size} bytes).`);
    }

    return {
      id: item.id,
      filePath,
      received: totalSegments,
      total: totalSegments,
    };
  } catch (error) {
    await fs.promises.rm(filePath, { force: true });
    throw error;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function parseTimecode(input) {
  if (input === null || input === undefined) {
    throw new Error("Empty timecode");
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error(`Invalid timecode: ${input}`);
    return input;
  }
  const text = String(input).trim();
  if (!text) throw new Error("Empty timecode");
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid timecode: ${text}`);
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n) || n < 0)) {
    throw new Error(`Invalid timecode: ${text}`);
  }
  if (parts.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function formatTimecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds * 1000);
  const ms = total % 1000;
  const totalSec = Math.floor(total / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return ms ? `${base}.${pad(ms, 3)}` : base;
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-i", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 50000) stderr = stderr.slice(-50000);
    });
    child.on("error", reject);
    child.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) {
        reject(new Error("Could not determine duration. Is the file a valid video?"));
        return;
      }
      const [, h, m, s] = match;
      resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
    });
  });
}

function normalizeDeleteRanges(deleteRanges, totalDuration) {
  const sorted = deleteRanges
    .map((r) => {
      const a = parseTimecode(r.start);
      const b = parseTimecode(r.end);
      const lo = Math.max(0, Math.min(a, b));
      const hi = Math.min(totalDuration, Math.max(a, b));
      return [lo, hi];
    })
    .filter(([a, b]) => b > a + 0.001)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const range of sorted) {
    if (merged.length && range[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return merged;
}

function computeKeepRanges(deleteRanges, totalDuration) {
  const keep = [];
  let cursor = 0;
  for (const [a, b] of deleteRanges) {
    if (a > cursor + 0.001) keep.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (totalDuration > cursor + 0.001) keep.push([cursor, totalDuration]);
  return keep;
}

let activeTrimChild = null;

function spawnTrimFfmpeg(args, { onProgressTime } = {}) {
  return new Promise((resolve, reject) => {
    logEvent("debug", "Running trim ffmpeg", { args: safeFfmpegArgs(args) });
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    activeTrimChild = child;

    let stderr = "";
    let stdoutBuf = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === "out_time_us" || key === "out_time_ms") {
          const us = Number(value);
          if (Number.isFinite(us) && onProgressTime) onProgressTime(us / 1_000_000);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    child.on("error", (error) => {
      activeTrimChild = null;
      reject(error);
    });

    child.on("close", (code, signal) => {
      activeTrimChild = null;
      if (signal) {
        reject(new Error(`Trim canceled (${signal})`));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.split("\n").filter(Boolean).slice(-4).join(" ");
        reject(new Error(detail || `ffmpeg exited with code ${code}.`));
      }
    });
  });
}

async function runTrimAccurate(input, output, deleteRanges, totalKept, item) {
  const expr = `not(${deleteRanges
    .map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`)
    .join("+")})`;
  const args = [
    "-hide_banner",
    "-y",
    "-nostats",
    "-progress",
    "pipe:1",
    "-i",
    input,
    "-vf",
    `select='${expr}',setpts=N/FRAME_RATE/TB`,
    "-af",
    `aselect='${expr}',asetpts=N/SR/TB`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    output,
  ];
  await spawnTrimFfmpeg(args, {
    onProgressTime: (seconds) => {
      send("trim:progress", {
        id: item.id,
        phase: "encoding",
        elapsed: seconds,
        total: totalKept,
      });
    },
  });
}

async function runTrimFast(input, output, keepRanges, item) {
  const tempDir = `${output}.trim-tmp`;
  await fs.promises.rm(tempDir, { recursive: true, force: true });
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    const segPaths = [];
    for (let i = 0; i < keepRanges.length; i++) {
      const [start, end] = keepRanges[i];
      const segPath = path.join(tempDir, `seg_${String(i).padStart(4, "0")}.mp4`);
      send("trim:progress", {
        id: item.id,
        phase: "extracting",
        segmentIndex: i,
        totalSegments: keepRanges.length,
      });
      await spawnTrimFfmpeg([
        "-hide_banner",
        "-y",
        "-nostats",
        "-ss",
        start.toFixed(3),
        "-to",
        end.toFixed(3),
        "-i",
        input,
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        segPath,
      ]);
      segPaths.push(segPath);
    }

    const listPath = path.join(tempDir, "list.txt");
    const listText = segPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.promises.writeFile(listPath, listText);

    send("trim:progress", { id: item.id, phase: "concatenating" });
    await spawnTrimFfmpeg([
      "-hide_banner",
      "-y",
      "-nostats",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ]);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Thumbnail preview
// ─────────────────────────────────────────────────────────────────────────────

const thumbnailCache = new Map();

async function generateThumbnail(item) {
  if (thumbnailCache.has(item.url)) return thumbnailCache.get(item.url);

  const headerText = await ffmpegHeaders(item);
  const dataUrl = await new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-nostats",
      "-loglevel", "error",
      "-headers", headerText,
      "-ss", "1",
      "-i", item.url,
      "-frames:v", "1",
      "-vf", "scale=320:-2",
      "-q:v", "5",
      "-f", "image2",
      "-vcodec", "mjpeg",
      "pipe:1",
    ];
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 30000);

    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => {
      stderr += c.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || chunks.length === 0) {
        const detail = stderr.split("\n").filter(Boolean).slice(-2).join(" ");
        reject(new Error(detail || `ffmpeg exited with code ${code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve(`data:image/jpeg;base64,${buf.toString("base64")}`);
    });
  });

  thumbnailCache.set(item.url, dataUrl);
  return dataUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools (audio extract / format convert / gif / concat)
// ─────────────────────────────────────────────────────────────────────────────

let activeToolsChild = null;

function spawnToolsFfmpeg(args, { onProgressTime } = {}) {
  return new Promise((resolve, reject) => {
    logEvent("debug", "Running tools ffmpeg", { args: safeFfmpegArgs(args) });
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    activeToolsChild = child;

    let stderr = "";
    let stdoutBuf = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === "out_time_us" || key === "out_time_ms") {
          const us = Number(value);
          if (Number.isFinite(us) && onProgressTime) onProgressTime(us / 1_000_000);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    child.on("error", (error) => {
      activeToolsChild = null;
      reject(error);
    });

    child.on("close", (code, signal) => {
      activeToolsChild = null;
      if (signal) {
        reject(new Error(`Operation canceled (${signal})`));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.split("\n").filter(Boolean).slice(-4).join(" ");
        reject(new Error(detail || `ffmpeg exited with code ${code}.`));
      }
    });
  });
}

const AUDIO_PRESETS = {
  mp3: { codec: "libmp3lame", bitrate: "192k", ext: "mp3" },
  aac: { codec: "aac", bitrate: "192k", ext: "m4a" },
  wav: { codec: "pcm_s16le", bitrate: null, ext: "wav" },
  flac: { codec: "flac", bitrate: null, ext: "flac" },
};

async function runExtractAudio(input, output, options, item, totalDuration) {
  const format = options?.format || "mp3";
  const preset = AUDIO_PRESETS[format];
  if (!preset) throw new Error(`Unsupported audio format: ${format}`);

  const args = [
    "-hide_banner",
    "-y",
    "-nostats",
    "-progress",
    "pipe:1",
    "-i",
    input,
    "-vn",
    "-c:a",
    preset.codec,
  ];
  if (preset.bitrate) args.push("-b:a", preset.bitrate);
  args.push(output);

  await spawnToolsFfmpeg(args, {
    onProgressTime: (seconds) => {
      send("tools:progress", {
        id: item.id,
        phase: "encoding",
        elapsed: seconds,
        total: totalDuration,
      });
    },
  });
}

async function runConvert(input, output, options, item, totalDuration) {
  const mode = options?.mode === "copy" ? "copy" : "encode";
  const args = [
    "-hide_banner",
    "-y",
    "-nostats",
    "-progress",
    "pipe:1",
    "-i",
    input,
  ];

  if (mode === "copy") {
    args.push("-c", "copy");
  } else {
    const scale = options?.scale;
    if (scale && scale !== "source") {
      const w = Number(scale);
      if (Number.isFinite(w) && w > 0) {
        args.push("-vf", `scale=${w}:-2:flags=lanczos`);
      }
    }
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p");
    args.push("-c:a", "aac", "-b:a", "192k");
  }

  if (output.toLowerCase().endsWith(".mp4") || output.toLowerCase().endsWith(".mov")) {
    args.push("-movflags", "+faststart");
  }
  args.push(output);

  await spawnToolsFfmpeg(args, {
    onProgressTime: (seconds) => {
      send("tools:progress", {
        id: item.id,
        phase: "encoding",
        elapsed: seconds,
        total: totalDuration,
      });
    },
  });
}

async function runGif(input, output, options, item) {
  const start = options?.start ? parseTimecode(options.start) : 0;
  const duration = options?.duration ? parseTimecode(options.duration) : null;
  const fps = Number(options?.fps) > 0 ? Number(options.fps) : 15;
  const width = Number(options?.width) > 0 ? Number(options.width) : 480;

  const args = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"];
  if (start > 0) args.push("-ss", start.toFixed(3));
  if (duration && duration > 0) args.push("-t", duration.toFixed(3));
  args.push(
    "-i",
    input,
    "-vf",
    `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop",
    "0",
    output
  );

  await spawnToolsFfmpeg(args, {
    onProgressTime: (seconds) => {
      send("tools:progress", {
        id: item.id,
        phase: "encoding",
        elapsed: seconds,
        total: duration || 0,
      });
    },
  });
}

async function runConcat(inputs, output, options, item) {
  const mode = options?.mode === "encode" ? "encode" : "copy";

  if (mode === "copy") {
    const tempDir = `${output}.concat-tmp`;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    await fs.promises.mkdir(tempDir, { recursive: true });
    try {
      const listPath = path.join(tempDir, "list.txt");
      const listText = inputs
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n");
      await fs.promises.writeFile(listPath, listText);

      send("tools:progress", { id: item.id, phase: "concatenating" });
      const args = [
        "-hide_banner",
        "-y",
        "-nostats",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
      ];
      if (output.toLowerCase().endsWith(".mp4") || output.toLowerCase().endsWith(".mov")) {
        args.push("-movflags", "+faststart");
      }
      args.push(output);
      await spawnToolsFfmpeg(args);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  // re-encode mode using concat filter
  const args = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"];
  for (const p of inputs) args.push("-i", p);
  const filterParts = [];
  for (let i = 0; i < inputs.length; i++) {
    filterParts.push(`[${i}:v:0][${i}:a:0]`);
  }
  const filter = `${filterParts.join("")}concat=n=${inputs.length}:v=1:a=1[v][a]`;
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k"
  );
  if (output.toLowerCase().endsWith(".mp4") || output.toLowerCase().endsWith(".mov")) {
    args.push("-movflags", "+faststart");
  }
  args.push(output);

  let totalDuration = 0;
  for (const p of inputs) {
    try {
      totalDuration += await probeDuration(p);
    } catch {
      // ignore failed probes; progress will degrade
    }
  }

  await spawnToolsFfmpeg(args, {
    onProgressTime: (seconds) => {
      send("tools:progress", {
        id: item.id,
        phase: "encoding",
        elapsed: seconds,
        total: totalDuration,
      });
    },
  });
}

ipcMain.handle("scan:start", async (_event, url) => startScan(url));

ipcMain.handle("scan:stop", async () => {
  closeScanWindow();
  send("scan:status", { state: "stopped" });
  return { ok: true };
});

ipcMain.handle("download:start", async (_event, item) => {
  const defaultPath = path.join(app.getPath("downloads"), outputFileNameForCandidate(item));
  const result = await dialog.showSaveDialog(mainWindow, {
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
  logEvent("info", "Download selected", {
    url: item.url,
    filePath: result.filePath,
    kind: item.kind,
    contentType: item.contentType,
    size: item.size,
  });

  try {
    const download = isStreamItem(item)
      ? await downloadStreamCandidate(item, result.filePath)
      : await downloadCandidate(item, result.filePath);
    send("download:status", { id: item.id, state: "done", filePath: result.filePath });
    logEvent("info", "Download finished", { filePath: result.filePath });
    return download;
  } catch (error) {
    send("download:status", { id: item.id, state: "error", message: error.message });
    logEvent("error", "Download failed", {
      url: item.url,
      filePath: result.filePath,
      error: error.message,
    });
    throw error;
  }
});

ipcMain.handle("file:show", async (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle("thumbnail:generate", async (_event, item) => {
  if (!item || !item.url) throw new Error("Item with URL is required.");
  try {
    const dataUrl = await generateThumbnail(item);
    return { ok: true, dataUrl };
  } catch (error) {
    logEvent("warn", "Thumbnail failed", { url: item.url, error: error.message });
    throw error;
  }
});

ipcMain.handle("trim:pickInput", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Pick a video file",
    properties: ["openFile"],
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "m4s"],
      },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  try {
    const [stat, duration] = await Promise.all([
      fs.promises.stat(filePath),
      probeDuration(filePath),
    ]);
    return {
      filePath,
      fileName: path.basename(filePath),
      size: stat.size,
      duration,
    };
  } catch (error) {
    logEvent("error", "Probe failed", { filePath, error: error.message });
    return { error: error.message };
  }
});

ipcMain.handle("trim:pickOutput", async (_event, suggestedName) => {
  const defaultPath = path.join(
    app.getPath("downloads"),
    suggestedName || `trimmed-${Date.now()}.mp4`
  );
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save trimmed video",
    defaultPath,
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return { filePath: result.filePath };
});

ipcMain.handle("trim:run", async (_event, options) => {
  const { input, output, ranges, mode, duration } = options || {};
  if (!input || !output) throw new Error("Input and output paths are required.");
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error("At least one delete range is required.");
  }

  const totalDuration = Number(duration) > 0 ? Number(duration) : await probeDuration(input);
  const deleteRanges = normalizeDeleteRanges(ranges, totalDuration);
  if (deleteRanges.length === 0) {
    throw new Error("No valid delete ranges after parsing.");
  }
  const keepRanges = computeKeepRanges(deleteRanges, totalDuration);
  if (keepRanges.length === 0) {
    throw new Error("Delete ranges cover the entire video; nothing left to keep.");
  }
  const totalKept = keepRanges.reduce((acc, [a, b]) => acc + (b - a), 0);

  const item = { id: `trim-${Date.now()}` };
  logEvent("info", "Trim starting", {
    input,
    output,
    mode,
    totalDuration,
    totalKept,
    deleteRanges: deleteRanges.map(([a, b]) => `${formatTimecode(a)}-${formatTimecode(b)}`),
    keepRanges: keepRanges.map(([a, b]) => `${formatTimecode(a)}-${formatTimecode(b)}`),
  });
  send("trim:status", { id: item.id, state: "running", mode, totalKept });

  try {
    if (mode === "fast") {
      await runTrimFast(input, output, keepRanges, item);
    } else {
      await runTrimAccurate(input, output, deleteRanges, totalKept, item);
    }
    const stat = await fs.promises.stat(output);
    if (stat.size < 1024) {
      throw new Error(`Output looks too small (${stat.size} bytes).`);
    }
    send("trim:status", { id: item.id, state: "done", filePath: output });
    logEvent("info", "Trim completed", { output, size: stat.size });
    return { ok: true, filePath: output, size: stat.size, totalKept };
  } catch (error) {
    await fs.promises.rm(output, { force: true });
    send("trim:status", { id: item.id, state: "error", message: error.message });
    logEvent("error", "Trim failed", { error: error.message });
    throw error;
  }
});

ipcMain.handle("trim:cancel", async () => {
  if (activeTrimChild && !activeTrimChild.killed) {
    activeTrimChild.kill("SIGKILL");
  }
  return { ok: true };
});

const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "m4s"];

ipcMain.handle("tools:pickFile", async (_event, options) => {
  const multi = !!options?.multi;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title || "选择文件",
    properties: multi ? ["openFile", "multiSelections"] : ["openFile"],
    filters: [{ name: "Video", extensions: VIDEO_EXTS }],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };

  const files = await Promise.all(
    result.filePaths.map(async (filePath) => {
      try {
        const [stat, duration] = await Promise.all([
          fs.promises.stat(filePath),
          probeDuration(filePath).catch(() => 0),
        ]);
        return {
          filePath,
          fileName: path.basename(filePath),
          size: stat.size,
          duration,
        };
      } catch (error) {
        return { filePath, error: error.message };
      }
    })
  );
  return { files };
});

ipcMain.handle("tools:pickOutput", async (_event, options) => {
  const suggested = options?.suggestedName || `output-${Date.now()}.${options?.ext || "mp4"}`;
  const ext = options?.ext || "mp4";
  const filters = options?.filters || [{ name: ext.toUpperCase(), extensions: [ext] }];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options?.title || "保存为",
    defaultPath: path.join(app.getPath("downloads"), suggested),
    filters,
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return { filePath: result.filePath };
});

ipcMain.handle("tools:run", async (_event, payload) => {
  const { op, input, inputs, output, options } = payload || {};
  if (!output) throw new Error("Output path is required.");

  const item = { id: `tools-${op}-${Date.now()}` };
  send("tools:status", { id: item.id, state: "running", op });
  logEvent("info", "Tool starting", { op, output, options });

  try {
    let totalDuration = 0;
    if (op !== "concat" && op !== "gif" && input) {
      try {
        totalDuration = await probeDuration(input);
      } catch {
        // probe is best-effort
      }
    }

    if (op === "audio") {
      if (!input) throw new Error("Input file is required.");
      await runExtractAudio(input, output, options, item, totalDuration);
    } else if (op === "convert") {
      if (!input) throw new Error("Input file is required.");
      await runConvert(input, output, options, item, totalDuration);
    } else if (op === "gif") {
      if (!input) throw new Error("Input file is required.");
      await runGif(input, output, options, item);
    } else if (op === "concat") {
      if (!Array.isArray(inputs) || inputs.length < 2) {
        throw new Error("At least two videos are required.");
      }
      await runConcat(inputs, output, options, item);
    } else {
      throw new Error(`Unknown operation: ${op}`);
    }

    const stat = await fs.promises.stat(output);
    if (stat.size < 256) {
      throw new Error(`Output looks too small (${stat.size} bytes).`);
    }
    send("tools:status", { id: item.id, state: "done", filePath: output });
    logEvent("info", "Tool completed", { op, output, size: stat.size });
    return { ok: true, filePath: output, size: stat.size };
  } catch (error) {
    await fs.promises.rm(output, { force: true }).catch(() => {});
    send("tools:status", { id: item.id, state: "error", message: error.message });
    logEvent("error", "Tool failed", { op, error: error.message });
    throw error;
  }
});

ipcMain.handle("tools:cancel", async () => {
  if (activeToolsChild && !activeToolsChild.killed) {
    activeToolsChild.kill("SIGKILL");
  }
  return { ok: true };
});

const INFO_EXTS = [
  "mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "m4s",
  "3gp", "mpg", "mpeg", "wmv", "ogv", "gif", "apng",
  "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma",
];

function probeRawInfo(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-i", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH."));
      } else {
        reject(error);
      }
    });
    child.on("close", () => resolve(stderr));
  });
}

function parseVideoStream(rest, item) {
  const codecMatch = rest.match(/^([A-Za-z0-9_]+)/);
  if (codecMatch) item.codec = codecMatch[1];
  const profile = rest.match(/^[A-Za-z0-9_]+\s*\(([^)]+)\)/);
  if (profile) item.profile = profile[1];
  const resMatch = rest.match(/(\b\d{2,5})x(\d{2,5})\b/);
  if (resMatch) {
    item.width = Number(resMatch[1]);
    item.height = Number(resMatch[2]);
  }
  const dar = rest.match(/DAR\s+([\d:]+)/);
  if (dar) item.dar = dar[1];
  const fpsMatch = rest.match(/([\d.]+)\s+fps/);
  if (fpsMatch) item.fps = Number(fpsMatch[1]);
  const brMatch = rest.match(/(\d+)\s*kb\/s/);
  if (brMatch) item.bitrate = Number(brMatch[1]);
  const pixMatch = rest.match(/,\s*(yuv\w+|gbrp\w*|gray\w*|rgba?\w*|bgra?\w*|nv\d+\w*|pal8)\b/);
  if (pixMatch) item.pixelFormat = pixMatch[1];
}

function parseAudioStream(rest, item) {
  const codecMatch = rest.match(/^([A-Za-z0-9_]+)/);
  if (codecMatch) item.codec = codecMatch[1];
  const profile = rest.match(/^[A-Za-z0-9_]+\s*\(([^)]+)\)/);
  if (profile) item.profile = profile[1];
  const hzMatch = rest.match(/(\d+)\s*Hz/);
  if (hzMatch) item.sampleRate = Number(hzMatch[1]);
  const chMatch = rest.match(/Hz,\s*([^,]+?)(?:,|$)/);
  if (chMatch) item.channels = chMatch[1].trim();
  const brMatch = rest.match(/(\d+)\s*kb\/s/);
  if (brMatch) item.bitrate = Number(brMatch[1]);
}

function parseMediaInfo(stderr) {
  const info = {
    format: "",
    durationText: "",
    duration: 0,
    bitrateText: "",
    bitrate: 0,
    start: "",
    metadata: {},
    videoStreams: [],
    audioStreams: [],
    otherStreams: [],
  };

  const inputMatch = stderr.match(/Input\s+#0,\s*([^\n]+?),\s*from\s+'/);
  if (inputMatch) info.format = inputMatch[1].trim();

  const durLine = stderr.match(/Duration:\s*([^\n]+)/);
  if (durLine) {
    const parts = durLine[1].split(",").map((p) => p.trim());
    for (const part of parts) {
      const dm = part.match(/^([\d:.]+|N\/A)$/);
      const sm = part.match(/^start:\s*(.+)$/);
      const bm = part.match(/^bitrate:\s*(.+)$/);
      if (dm && !info.durationText) info.durationText = dm[1];
      if (sm) info.start = sm[1];
      if (bm) info.bitrateText = bm[1];
    }
    const t = info.durationText.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (t) info.duration = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    const b = info.bitrateText.match(/(\d+)\s*kb\/s/);
    if (b) info.bitrate = Number(b[1]);
  }

  const inputIdx = stderr.indexOf("Input #0");
  const durIdx = inputIdx >= 0 ? stderr.indexOf("Duration:", inputIdx) : -1;
  if (inputIdx >= 0 && durIdx > inputIdx) {
    const block = stderr.slice(inputIdx, durIdx);
    const metaIdx = block.indexOf("Metadata:");
    if (metaIdx >= 0) {
      const lines = block.slice(metaIdx).split("\n").slice(1);
      for (const line of lines) {
        if (!line.trim()) continue;
        const m = line.match(/^\s+([^:]+?)\s*:\s*(.*)$/);
        if (!m) break;
        info.metadata[m[1].trim()] = m[2].trim();
      }
    }
  }

  const streamRegex = /Stream\s+#(\d+):(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?:\s+(Video|Audio|Subtitle|Data|Attachment):\s*([^\n]+)/g;
  let match;
  while ((match = streamRegex.exec(stderr))) {
    const [, , idx, lang, kind, rest] = match;
    const item = {
      index: Number(idx),
      language: lang || "",
      kind,
      raw: rest.trim(),
    };
    if (kind === "Video") {
      parseVideoStream(rest, item);
      info.videoStreams.push(item);
    } else if (kind === "Audio") {
      parseAudioStream(rest, item);
      info.audioStreams.push(item);
    } else {
      info.otherStreams.push(item);
    }
  }
  return info;
}

ipcMain.handle("info:pickFile", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择媒体文件",
    properties: ["openFile"],
    filters: [
      { name: "Media", extensions: INFO_EXTS },
      { name: "All", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { filePath: result.filePaths[0] };
});

ipcMain.handle("info:probe", async (_event, filePath) => {
  if (!filePath) throw new Error("File path is required.");
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Not a file.");

  const stderr = await probeRawInfo(filePath);
  const parsed = parseMediaInfo(stderr);

  return {
    filePath,
    fileName: path.basename(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: parsed,
    raw: stderr,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// yt-dlp integration (B站 / YouTube / 抖音 / Twitter / etc.)
// ─────────────────────────────────────────────────────────────────────────────

let cachedYtDlpPath;
function ytDlpPath() {
  if (cachedYtDlpPath) return cachedYtDlpPath;
  if (process.env.YT_DLP_PATH) {
    cachedYtDlpPath = process.env.YT_DLP_PATH;
    return cachedYtDlpPath;
  }
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  if (app.isPackaged) {
    const resourcePath = path.join(process.resourcesPath, exe);
    if (fs.existsSync(resourcePath)) {
      cachedYtDlpPath = resourcePath;
      return cachedYtDlpPath;
    }
  } else {
    const archDir = `${process.platform}-${process.arch}`;
    const devPath = path.join(__dirname, "..", "resources", "yt-dlp", archDir, exe);
    if (fs.existsSync(devPath)) {
      cachedYtDlpPath = devPath;
      return cachedYtDlpPath;
    }
  }
  cachedYtDlpPath = exe;
  return cachedYtDlpPath;
}

function runYtDlp(args, { onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    if (signal) {
      signal.kill = () => {
        killed = true;
        if (!child.killed) child.kill("SIGKILL");
      };
    }

    const handleLine = (line) => {
      if (onLine) onLine(line);
    };

    let buf = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buf += text;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 80000) stderr = stderr.slice(-80000);
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "yt-dlp 未找到。请安装 yt-dlp（pip install yt-dlp 或 brew install yt-dlp），或设置 YT_DLP_PATH 环境变量。"
          )
        );
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (buf) handleLine(buf);
      if (killed) {
        reject(new Error("已取消"));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
        reject(new Error(tail || `yt-dlp 退出码 ${code}`));
      }
    });
  });
}

function summarizeFormat(f) {
  const hasV = f.vcodec && f.vcodec !== "none";
  const hasA = f.acodec && f.acodec !== "none";
  let kind = "other";
  if (hasV && hasA) kind = "combined";
  else if (hasV) kind = "video";
  else if (hasA) kind = "audio";

  return {
    formatId: f.format_id,
    ext: f.ext,
    kind,
    resolution: f.resolution || (f.width && f.height ? `${f.width}x${f.height}` : ""),
    width: f.width || 0,
    height: f.height || 0,
    fps: f.fps || 0,
    vcodec: hasV ? f.vcodec : "",
    acodec: hasA ? f.acodec : "",
    abr: f.abr || 0,
    tbr: f.tbr || 0,
    filesize: f.filesize || f.filesize_approx || 0,
    formatNote: f.format_note || "",
    protocol: f.protocol || "",
  };
}

ipcMain.handle("dlp:listFormats", async (_event, payload) => {
  const url = typeof payload === "string" ? payload : payload?.url;
  const cookiesFromBrowser = typeof payload === "object" ? payload?.cookiesFromBrowser : "";
  if (!url) throw new Error("URL is required.");
  logEvent("info", "yt-dlp listing formats", { url, cookiesFromBrowser });

  const args = ["-J", "--no-warnings", "--no-playlist", "--no-call-home"];
  if (cookiesFromBrowser) {
    args.push("--cookies-from-browser", cookiesFromBrowser);
  }
  args.push(url);

  const { stdout } = await runYtDlp(args);

  let json;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    throw new Error("解析 yt-dlp 输出失败：" + error.message);
  }

  const formats = (json.formats || [])
    .filter((f) => f.format_id && f.protocol !== "mhtml")
    .map(summarizeFormat);

  return {
    title: json.title || "",
    uploader: json.uploader || json.channel || "",
    duration: json.duration || 0,
    thumbnail: json.thumbnail || "",
    webpageUrl: json.webpage_url || url,
    extractor: json.extractor_key || json.extractor || "",
    formats,
  };
});

ipcMain.handle("dlp:pickOutput", async (_event, options) => {
  const ext = options?.ext || "mp4";
  const suggested = options?.suggestedName || `download-${Date.now()}.${ext}`;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "保存为",
    defaultPath: path.join(app.getPath("downloads"), suggested),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return { filePath: result.filePath };
});

let activeDlpSignal = null;

ipcMain.handle("dlp:download", async (_event, payload) => {
  const { url, format, output, mergeFormat } = payload || {};
  if (!url) throw new Error("URL is required.");
  if (!output) throw new Error("Output path is required.");

  const id = `dlp-${Date.now()}`;
  send("dlp:status", { id, state: "running" });
  logEvent("info", "yt-dlp downloading", { url, format, output });

  const ext = path.extname(output).replace(/^\./, "").toLowerCase() || "mp4";
  const concurrency = Number(payload?.concurrency) > 0 ? Number(payload.concurrency) : 8;
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-call-home",
    "--no-mtime",
    "--newline",
    "--ffmpeg-location",
    ffmpegPath(),
    // Speed: download HLS/DASH fragments in parallel
    "-N",
    String(concurrency),
    // Speed: chunk single-file HTTP downloads so slow sources don't stall one socket
    "--http-chunk-size",
    "10M",
    // Resilience against transient errors / throttling
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "-f",
    format || "bv*+ba/b",
    "-o",
    output,
  ];
  if (payload?.cookiesFromBrowser) {
    args.push("--cookies-from-browser", payload.cookiesFromBrowser);
  } else if (payload?.cookiesFile) {
    args.push("--cookies", payload.cookiesFile);
  }
  if (payload?.userAgent) {
    args.push("--user-agent", payload.userAgent);
  }
  if (payload?.referer) {
    args.push("--referer", payload.referer);
  }
  if (mergeFormat || ext === "mp4" || ext === "mkv" || ext === "webm") {
    args.push("--merge-output-format", mergeFormat || ext);
  }
  args.push(url);

  const signal = {};
  activeDlpSignal = signal;

  try {
    await runYtDlp(args, {
      signal,
      onLine: (line) => {
        if (!line) return;
        const dl = line.match(/^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);
        if (dl) {
          send("dlp:progress", {
            id,
            percent: Number(dl[1]),
            total: dl[2],
            speed: dl[3] || "",
            eta: dl[4] || "",
            phase: "downloading",
          });
          return;
        }
        if (/^\[Merger\]/.test(line)) {
          send("dlp:progress", { id, phase: "merging" });
          return;
        }
        if (/^\[ExtractAudio\]/.test(line) || /^\[ffmpeg\]/.test(line)) {
          send("dlp:progress", { id, phase: "post-processing" });
          return;
        }
      },
    });

    if (!fs.existsSync(output)) {
      const dir = path.dirname(output);
      const stem = path.parse(output).name;
      const candidates = (await fs.promises.readdir(dir)).filter((f) => f.startsWith(stem));
      if (candidates.length > 0) {
        const found = path.join(dir, candidates[0]);
        send("dlp:status", { id, state: "done", filePath: found });
        return { ok: true, filePath: found };
      }
      throw new Error("下载完成但未找到输出文件");
    }

    const stat = await fs.promises.stat(output);
    send("dlp:status", { id, state: "done", filePath: output });
    logEvent("info", "yt-dlp completed", { output, size: stat.size });
    return { ok: true, filePath: output, size: stat.size };
  } catch (error) {
    send("dlp:status", { id, state: "error", message: error.message });
    logEvent("error", "yt-dlp failed", { error: error.message });
    throw error;
  } finally {
    activeDlpSignal = null;
  }
});

ipcMain.handle("dlp:cancel", async () => {
  if (activeDlpSignal?.kill) activeDlpSignal.kill();
  return { ok: true };
});

app.whenReady().then(createMainWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!app.isReady()) return;
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on("before-quit", closeScanWindow);
