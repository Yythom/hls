const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function createScanner({ send, logEvent }) {
  // The guest webContents of the <webview> embedded in the scan tab. Injected
  // via setScanContents() once the renderer mounts the webview.
  let scanContents = null;
  let scanMeta = null;
  let activeScanSession = null;
  // Injected after construction (breaks the scanner<->ytdlp dependency cycle).
  let cookieExporter = null;
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
    // Capture the exact Cookie the browser sent while playing — for sites that
    // require login (e.g. paid courses) the media/segment requests are
    // authenticated by this cookie, often on a different domain than the page.
    "cookie",
  ]);

  const HEADER_NAMES = {
    accept: "Accept",
    "accept-language": "Accept-Language",
    origin: "Origin",
    referer: "Referer",
    "user-agent": "User-Agent",
    cookie: "Cookie",
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
    if (!scanContents || scanContents.isDestroyed()) return;

    try {
      const urls = await scanContents.executeJavaScript(`
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

  function detachWebRequest(session) {
    if (!session) return;
    const filter = { urls: ["http://*/*", "https://*/*"] };
    try {
      session.webRequest.onBeforeSendHeaders(filter, null);
      session.webRequest.onBeforeRequest(filter, null);
      session.webRequest.onHeadersReceived(filter, null);
    } catch {
      // Session may already be torn down — ignore.
    }
  }

  // The browser now lives inside the main window (embedded <webview>), so there
  // is no window to close. Resetting means: stop capturing, clear state, and
  // park the webview on a blank page.
  function resetScan() {
    detachWebRequest(activeScanSession);

    if (scanContents && !scanContents.isDestroyed()) {
      scanContents.removeAllListeners("did-finish-load");
      scanContents.removeAllListeners("did-fail-load");
      scanContents.loadURL("about:blank").catch(() => {});
    }

    scanMeta = null;
    activeScanSession = null;
    requestHeadersByUrl.clear();
    logEvent("info", "Reset scan");
  }

  // Best-effort registrable domain (last two labels). Good enough to scope
  // imported cookies to the target site without bundling a public-suffix list.
  function baseDomainOf(hostname) {
    const labels = String(hostname || "").split(".").filter(Boolean);
    if (labels.length <= 2) return labels.join(".");
    return labels.slice(-2).join(".");
  }

  function parseNetscapeCookies(text) {
    const cookies = [];
    for (const raw of text.split(/\r?\n/)) {
      let line = raw;
      if (!line.trim()) continue;
      let httpOnly = false;
      if (line.startsWith("#HttpOnly_")) {
        httpOnly = true;
        line = line.slice("#HttpOnly_".length);
      } else if (line.startsWith("#")) {
        continue;
      }
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const [domain, , cookiePath, secureFlag, expiry, name, value] = parts;
      if (!domain || !name) continue;
      cookies.push({
        domain,
        path: cookiePath || "/",
        secure: secureFlag === "TRUE",
        expiry: Number(expiry) || 0,
        name,
        value,
        httpOnly,
      });
    }
    return cookies;
  }

  // Pull cookies from a locally installed browser (via yt-dlp) and inject the
  // ones relevant to the target site into the scan window's session, so the
  // user doesn't have to log in again inside the scan window.
  async function loadBrowserCookies(browser, pageUrl, session) {
    if (!browser) return 0;
    if (!cookieExporter) throw new Error("Cookie 导入功能未初始化。");

    const file = await cookieExporter(browser);
    let text;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } finally {
      fs.promises.rm(file, { force: true }).catch(() => {});
    }

    const baseDomain = baseDomainOf(new URL(pageUrl).hostname);
    let imported = 0;
    for (const c of parseNetscapeCookies(text)) {
      const host = c.domain.replace(/^\./, "");
      if (baseDomain && !host.endsWith(baseDomain)) continue;

      const cookie = {
        url: `${c.secure ? "https" : "http"}://${host}${c.path}`,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
      };
      if (c.domain.startsWith(".")) cookie.domain = c.domain;
      if (c.expiry > 0) cookie.expirationDate = c.expiry;

      try {
        await session.cookies.set(cookie);
        imported++;
      } catch (error) {
        logEvent("debug", "Skipped a cookie", { name: c.name, host, error: error.message });
      }
    }
    return imported;
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

  async function startScan(rawUrl, options = {}) {
    const pageUrl = normalizePageUrl(rawUrl);
    const cookiesFromBrowser = options?.cookiesFromBrowser || "";

    if (!scanContents || scanContents.isDestroyed()) {
      throw new Error("扫描视图未就绪，请稍候重试。");
    }

    resetScan();
    discovered.clear();
    scanMeta = { pageUrl, startedAt: Date.now() };
    logEvent("info", "Starting scan", { pageUrl });

    scanContents.setAudioMuted(true);

    const webContentsId = scanContents.id;
    const scanSession = scanContents.session;
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

    scanContents.on("did-finish-load", async () => {
      send("scan:status", { state: "loaded", pageUrl });
      logEvent("info", "Page loaded", { pageUrl });
      await collectDomCandidates();
      setTimeout(collectDomCandidates, 2500);
      setTimeout(collectDomCandidates, 8000);
    });

    scanContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      if (validatedURL === pageUrl) {
        send("scan:status", { state: "error", pageUrl, message: `${errorCode}: ${errorDescription}` });
        logEvent("error", "Page load failed", { pageUrl, errorCode, errorDescription });
      }
    });

    if (cookiesFromBrowser) {
      try {
        const count = await loadBrowserCookies(cookiesFromBrowser, pageUrl, scanSession);
        send("scan:log", { level: "info", message: `已从 ${cookiesFromBrowser} 导入 ${count} 条 Cookie` });
        logEvent("info", "Imported browser cookies", { browser: cookiesFromBrowser, count });
      } catch (error) {
        send("scan:log", { level: "warn", message: `导入 ${cookiesFromBrowser} Cookie 失败：${error.message}` });
        logEvent("warn", "Browser cookie import failed", { browser: cookiesFromBrowser, error: error.message });
      }
    }

    send("scan:status", { state: "loading", pageUrl });
    await scanContents.loadURL(pageUrl);

    setTimeout(() => {
      send("scan:status", {
        state: "idle",
        pageUrl,
        count: discovered.size,
      });
      logEvent("info", "Scan listening (webview)", { pageUrl, count: discovered.size });
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

    // Prefer the exact Cookie the browser sent for this resource; only fall
    // back to a session lookup (by the resource's own domain) when we didn't
    // capture one — the captured value is the ground truth that worked.
    if (!headers.Cookie) {
      const cookie = await cookieHeaderForItem(item);
      if (cookie) headers.Cookie = cookie;
    }

    logEvent("debug", "Prepared download headers", {
      url: item.url,
      headers: Object.keys(headers),
      hasCookie: Boolean(headers.Cookie),
    });

    return headers;
  }

  return {
    startScan,
    setCookieExporter: (fn) => {
      cookieExporter = fn;
    },
    setScanContents: (contents) => {
      scanContents = contents;
    },
    resetScan,
    stopScan: () => {
      resetScan();
      send("scan:status", { state: "stopped" });
      return { ok: true };
    },
    makeDownloadHeaders,
  };
}

module.exports = { createScanner };
