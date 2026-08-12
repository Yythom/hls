const path = require("path");
const crypto = require("crypto");

function createScanner({ send, logEvent }) {
  // The guest webContents of the <webview> embedded in the scan tab. Injected
  // via setScanContents() once the renderer mounts the webview.
  let scanContents = null;
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

  function sanitizeFileName(value) {
    return String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
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
      fileName:
        candidate.fileName ||
        existing?.fileName ||
        fileNameFromUrl(
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

  // CNTV (央视网) publishes several links for the same video: `hls_url` is plain
  // HLS, while `enc` / `enc2` / `h5e` are scrambled. The web player always
  // requests `h5e`, so passive network capture only ever sees a stream whose
  // video payload no decoder can render (container and duration look fine, every
  // frame comes out green/black). The official lookup API hands out the plain
  // link — and the real title — so ask it directly whenever a CNTV player is
  // present on the page.
  const CNTV_API = "https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do";
  const resolvedCntvGuids = new Set();

  function isCntvHost(hostname) {
    return /(?:^|\.)(?:cntv\.cn|cctv\.com|cctvpic\.com)$/i.test(hostname) || /cntv/i.test(hostname);
  }

  // CNTV media paths embed the guid, e.g.
  // /asp/h5e/hls/main/0303000a/3/default/<guid>/main.m3u8
  function cntvGuidFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (!isCntvHost(parsed.hostname)) return "";
      const match = parsed.pathname.match(/\/([0-9a-f]{32})(?:\/|$)/i);
      return match ? match[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  async function collectCntvGuidsFromPage() {
    if (!scanContents || scanContents.isDestroyed()) return [];

    try {
      return await scanContents.executeJavaScript(`
        (() => {
          const html = document.documentElement.outerHTML;
          const found = new Set();
          const patterns = [
            /videoCenterId["'\\s:=,]+([0-9a-f]{32})/gi,
            /\\bplay\\(\\s*["']([0-9a-f]{32})["']/gi,
            /\\bguid["'\\s:=,]+([0-9a-f]{32})/gi,
            /[?&]pid=([0-9a-f]{32})/gi,
          ];
          for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) found.add(match[1].toLowerCase());
          }
          return Array.from(found);
        })();
      `);
    } catch {
      return [];
    }
  }

  // The master playlist sometimes advertises only the lowest rendition even though
  // higher ones exist as real files. Requesting a bitrate that doesn't exist does
  // not 404 — the CDN silently serves a copy of the lowest one — so identify real
  // renditions by the byte size of their first segment and drop the duplicates.
  const CNTV_PROBE_BITRATES = [450, 850, 1200, 2000, 4000];

  async function headContentLength(url) {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!res.ok) return 0;
    return Number(res.headers.get("content-length")) || 0;
  }

  async function probeCntvRenditions(masterUrl, title) {
    const res = await fetch(masterUrl);
    if (!res.ok) return;
    const text = await res.text();

    const declared = new Map();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const abs = new URL(line, masterUrl).toString();
      const match = abs.match(/\/(\d{3,5})\.m3u8(?:[?#]|$)/);
      if (match) declared.set(Number(match[1]), abs);
    }
    if (declared.size === 0) return;

    const [baseBitrate, baseUrl] = [...declared.entries()][0];
    const sizeOwners = new Map();
    const bitrates = [...new Set([...declared.keys(), ...CNTV_PROBE_BITRATES])].sort((a, b) => a - b);

    for (const bitrate of bitrates) {
      const variantUrl = baseUrl
        .split(`/${baseBitrate}/`)
        .join(`/${bitrate}/`)
        .replace(`/${baseBitrate}.m3u8`, `/${bitrate}.m3u8`);
      const firstSegment = variantUrl.replace(/[^/]+\.m3u8.*$/, "0.ts");

      let size = 0;
      try {
        size = await headContentLength(firstSegment);
      } catch {
        continue;
      }
      // No segment, or byte-identical to a lower rendition we already accepted.
      if (!size || sizeOwners.has(size)) continue;
      sizeOwners.set(size, bitrate);

      // Already reachable by picking the best variant off the master playlist.
      if (declared.has(bitrate)) continue;

      addCandidate({
        url: variantUrl,
        contentType: "application/vnd.apple.mpegurl",
        source: "cntv-api",
        fileName: title ? `${title} [${bitrate}k].m3u8` : "",
      });
      logEvent("info", "Found unlisted CNTV rendition", { bitrate, segmentBytes: size });
    }
  }

  async function resolveCntvGuid(guid) {
    const res = await fetch(`${CNTV_API}?pid=${guid}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: scanMeta?.pageUrl || "https://www.cctv.com/",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const hlsUrl = data?.hls_url;
    if (!hlsUrl) return null;

    const title = sanitizeFileName(data?.title);
    addCandidate({
      url: hlsUrl,
      contentType: "application/vnd.apple.mpegurl",
      source: "cntv-api",
      fileName: title ? `${title}.m3u8` : "",
    });

    try {
      await probeCntvRenditions(hlsUrl, title);
    } catch (error) {
      logEvent("debug", "CNTV rendition probe skipped", { error: error.message });
    }

    return { title: data?.title || "", hlsUrl, protected: data?.is_protected };
  }

  async function resolveCntvSources() {
    const guids = new Set(await collectCntvGuidsFromPage());
    for (const item of discovered.values()) {
      const guid = cntvGuidFromUrl(item.url);
      if (guid) guids.add(guid);
    }

    for (const guid of guids) {
      if (resolvedCntvGuids.has(guid)) continue;
      resolvedCntvGuids.add(guid);

      try {
        const resolved = await resolveCntvGuid(guid);
        if (!resolved) {
          logEvent("info", "CNTV API returned no plain HLS link", { guid });
          continue;
        }
        send("scan:log", {
          level: "info",
          message: `已从央视网接口取到未加扰源：${resolved.title || guid}`,
        });
        logEvent("info", "Resolved CNTV plain HLS source", {
          guid,
          title: resolved.title,
          isProtected: resolved.protected,
        });
      } catch (error) {
        logEvent("warn", "CNTV lookup failed", { guid, error: error.message });
      }
    }
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

    if (!scanContents || scanContents.isDestroyed()) {
      throw new Error("扫描视图未就绪，请稍候重试。");
    }

    resetScan();
    discovered.clear();
    resolvedCntvGuids.clear();
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
      const sweep = async () => {
        await collectDomCandidates();
        await resolveCntvSources();
      };
      const safeSweep = () => sweep().catch(() => {});
      await safeSweep();
      setTimeout(safeSweep, 2500);
      setTimeout(safeSweep, 8000);
    });

    scanContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      if (validatedURL === pageUrl) {
        send("scan:status", { state: "error", pageUrl, message: `${errorCode}: ${errorDescription}` });
        logEvent("error", "Page load failed", { pageUrl, errorCode, errorDescription });
      }
    });

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
