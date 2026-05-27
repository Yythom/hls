const path = require("path");
const crypto = require("crypto");

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  VIDEO_EXTENSIONS,
  VIDEO_CONTENT_TYPES,
  isLikelyVideoResource,
  hashUrl,
  inferKind,
  fileNameFromUrl,
  extensionForKind,
  isStreamItem,
  isMp4Item,
  outputFileNameForCandidate,
  delay,
};
