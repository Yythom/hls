const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { delay } = require("./media");

const DOWNLOAD_MAX_RETRIES = 5;

function createHlsDownloader({
  makeDownloadHeaders,
  runFfmpeg,
  probeVideoParams,
  downloadFfmpegStream,
  send,
  logEvent,
}) {
  const HLS_MAX_PARALLEL = 6;
  const HLS_KEY_FETCH_RETRIES = 5;
  // Post-download sanity check: decode this many seconds and fail the task if the
  // decoder reports more than this many errors (a healthy file reports none).
  const VERIFY_SECONDS = 20;
  const VERIFY_ERROR_THRESHOLD = 24;
  const DECODE_ERROR_PATTERN = /error while decoding MB|concealing \d+ DC|Reference \d+ >= \d+|no frame!|non-existing PPS|decode_slice_header error/;

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
    let pendingDiscontinuity = false;
    let discontinuityCount = 0;

    for (let raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line === "#EXT-X-DISCONTINUITY") {
        pendingDiscontinuity = true;
        discontinuityCount++;
        continue;
      }

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
          discontinuity: pendingDiscontinuity,
        });
        pendingDuration = 0;
        pendingByterange = null;
        pendingDiscontinuity = false;
      }
    }

    return { variants, segments, hasMap, discontinuityCount };
  }

  function ivForSegment(segment) {
    if (segment.key?.iv) return segment.key.iv;
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(segment.sequence), 8);
    return iv;
  }

  // Marks a failure that retrying cannot fix, so the segment loop gives up at once
  // instead of burning through the full backoff schedule on every segment.
  function fatalError(message) {
    const error = new Error(message);
    error.fatal = true;
    return error;
  }

  async function fetchAsBuffer(url, headers, expectRange) {
    const res = await fetch(url, { redirect: "follow", headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }

    // A server that ignores our Range header answers 200 with the whole resource.
    // Accepting that silently would splice a full file in where one slice belongs,
    // which corrupts the merged stream without any visible failure.
    if (expectRange) {
      if (res.status !== 206) {
        throw fatalError(
          `Server ignored Range request (HTTP ${res.status}, expected 206) for ${url}`
        );
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length !== expectRange.length) {
        throw fatalError(
          `Byterange size mismatch for ${url}: got ${buffer.length}, expected ${expectRange.length}`
        );
      }
      return buffer;
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
        if (error.fatal) break;
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

  // Most HLS segments are PKCS#7 padded, but some sources encrypt block-aligned data
  // with no padding at all. Stripping a phantom padding block would silently damage
  // the tail of every segment, so fall back to a raw decrypt when unpadding fails.
  function decryptSegment(encrypted, keyData, iv) {
    try {
      const decipher = crypto.createDecipheriv("aes-128-cbc", keyData, iv);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (error) {
      const decipher = crypto.createDecipheriv("aes-128-cbc", keyData, iv);
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      logEvent("debug", "Segment decrypted without PKCS#7 padding", { error: error.message });
      return plain;
    }
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
        const encrypted = await fetchAsBuffer(segment.url, segHeaders, segment.byterange);
        const plain = keyData ? decryptSegment(encrypted, keyData, ivForSegment(segment)) : encrypted;
        await fs.promises.writeFile(segPath, plain);
        return plain.length;
      } catch (error) {
        lastError = error;
        if (error.fatal) break;
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
    // One shared error handler: attaching a fresh listener per segment leaked them
    // and tripped MaxListenersExceededWarning on playlists with many segments.
    let writeError = null;
    out.on("error", (error) => {
      writeError = error;
    });

    try {
      for (const p of segmentPaths) {
        if (writeError) throw writeError;
        await new Promise((resolve, reject) => {
          const src = fs.createReadStream(p);
          src.on("error", reject);
          src.on("end", resolve);
          src.pipe(out, { end: false });
        });
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }

    if (writeError) throw writeError;
  }

  async function writeConcatList(segmentPaths, listPath) {
    const body = segmentPaths
      .map((p) => `file '${p.split(path.sep).join("/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.promises.writeFile(listPath, `${body}\n`, "utf8");
  }

  // Across an #EXT-X-DISCONTINUITY the encoder may switch resolution, profile or
  // pixel format. Concatenating those byte-for-byte and remuxing with `-c copy`
  // keeps only the first segment's parameter sets, so everything after the first
  // discontinuity decodes into garbage. Probe the segment that starts each
  // discontinuity and only pay for a re-encode when the parameters actually differ.
  async function needsReencode(playlist, segmentPaths) {
    if (!playlist.discontinuityCount) return false;
    if (!probeVideoParams) return true;

    const boundaries = [0];
    playlist.segments.forEach((segment, idx) => {
      if (idx > 0 && segment.discontinuity) boundaries.push(idx);
    });

    const probed = [];
    for (const idx of boundaries.slice(0, 8)) {
      const params = await probeVideoParams(segmentPaths[idx]);
      if (!params) return true;
      probed.push(`${params.codec}/${params.profile}/${params.resolution}/${params.pixFmt}`);
    }

    const mismatch = probed.some((sig) => sig !== probed[0]);
    logEvent("info", "Checked HLS discontinuity boundaries", {
      discontinuities: playlist.discontinuityCount,
      probed,
      mismatch,
    });
    return mismatch;
  }

  // A remux never fails on damaged video payloads: the container, duration and
  // resolution all come out right while every frame decodes to green/black. Decode
  // a slice of the result so those downloads are reported as failures, not successes.
  async function verifyDecodable(item, filePath) {
    const result = await runFfmpeg(
      [
        "-hide_banner",
        "-nostats",
        "-v",
        "error",
        "-i",
        filePath,
        "-t",
        String(VERIFY_SECONDS),
        "-an",
        "-f",
        "null",
        "-",
      ],
      item,
      {
        filePath,
        mode: "verify",
        missingFfmpegIsFatal: true,
        countPattern: DECODE_ERROR_PATTERN,
      }
    );

    const errors = result.matchCount ?? 0;
    logEvent("info", "Verified HLS output", { filePath, decodeErrors: errors });
    if (errors > VERIFY_ERROR_THRESHOLD) {
      throw new Error(
        `视频轨解码错误过多（前 ${VERIFY_SECONDS} 秒 ${errors} 处），该源可能对视频做了加扰保护，下载到的分片本身无法解码。`
      );
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
      send("download:status", { id: item.id, state: "repairing", filePath });

      if (await needsReencode(playlist, segmentPaths)) {
        const listPath = path.join(tempDir, "concat.txt");
        await writeConcatList(segmentPaths, listPath);
        logEvent("warn", "HLS encoding parameters change across a discontinuity; re-encoding", {
          discontinuities: playlist.discontinuityCount,
        });

        await runFfmpeg(
          [
            "-hide_banner",
            "-y",
            "-nostats",
            "-progress",
            "pipe:1",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            listPath,
            "-fflags",
            "+genpts",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            filePath,
          ],
          item,
          { filePath, mode: "reencode", missingFfmpegIsFatal: true }
        );
      } else {
        const concatPath = path.join(tempDir, "all.ts");
        await concatTsFiles(segmentPaths, concatPath);
        logEvent("info", "Concatenated HLS segments", { concatPath });

        await runFfmpeg(
          [
            "-hide_banner",
            "-y",
            "-nostats",
            "-fflags",
            "+genpts",
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
      }

      const stat = await fs.promises.stat(filePath);
      if (stat.size < 1024) {
        throw new Error(`Output file looks too small (${stat.size} bytes).`);
      }

      send("download:status", { id: item.id, state: "verifying", filePath });
      await verifyDecodable(item, filePath);

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
