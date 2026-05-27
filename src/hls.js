const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { delay } = require("./media");

const DOWNLOAD_MAX_RETRIES = 5;

function createHlsDownloader({ makeDownloadHeaders, runFfmpeg, downloadFfmpegStream, send, logEvent }) {
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

  async function downloadStreamCandidate(item, filePath) {
    if (item.kind === "HLS") return downloadHlsCandidate(item, filePath);
    return downloadFfmpegStream(item, filePath);
  }

  return { downloadHlsCandidate, downloadStreamCandidate };
}

module.exports = { createHlsDownloader };
