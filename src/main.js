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

app.whenReady().then(createMainWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!app.isReady()) return;
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on("before-quit", closeScanWindow);
