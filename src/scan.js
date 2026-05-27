const path = require("path");
const crypto = require("crypto");

function createScanner({ BrowserWindow, send, logEvent }) {
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

  return {
    startScan,
    closeScanWindow,
    stopScan: () => {
      closeScanWindow();
      send("scan:status", { state: "stopped" });
      return { ok: true };
    },
    makeDownloadHeaders,
  };
}

module.exports = { createScanner };
