const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function createTools({ ffmpegPath, ffmpegHeaders, safeFfmpegArgs, send, logEvent }) {
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

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function jpegQscaleFromQuality(quality) {
    return String(Math.round(31 - (clampNumber(quality, 1, 100, 100) / 100) * 29));
  }

  function avifCrfFromQuality(quality) {
    return String(Math.round(63 - (clampNumber(quality, 1, 100, 100) / 100) * 58));
  }

  async function runImage(input, output, options, item) {
    const format = String(options?.format || path.extname(output).slice(1) || "webp").toLowerCase();
    const quality = clampNumber(options?.quality, 1, 100, 100);
    const width = clampNumber(options?.width, 16, 20000, 0);

    const args = [
      "-hide_banner",
      "-y",
      "-nostats",
      "-i",
      input,
      "-frames:v",
      "1",
    ];

    if (width > 0) {
      args.push("-vf", `scale=${width}:-1:flags=lanczos`);
    }

    if (options?.stripMetadata !== false) {
      args.push("-map_metadata", "-1");
    }

    if (format === "jpg" || format === "jpeg") {
      args.push("-f", "image2", "-c:v", "mjpeg", "-q:v", jpegQscaleFromQuality(quality));
    } else if (format === "png") {
      args.push("-f", "image2", "-c:v", "png", "-compression_level", "9", "-pred", "mixed");
    } else if (format === "webp") {
      args.push(
        "-f",
        "webp",
        "-c:v",
        "libwebp",
        "-quality",
        String(Math.round(quality)),
        "-compression_level",
        "6"
      );
    } else if (format === "avif") {
      args.push(
        "-f",
        "avif",
        "-c:v",
        "libaom-av1",
        "-still-picture",
        "1",
        "-crf",
        avifCrfFromQuality(quality),
        "-cpu-used",
        "6"
      );
    } else if (format === "tif" || format === "tiff") {
      args.push("-f", "image2", "-c:v", "tiff", "-compression_algo", "lzw");
    } else if (format === "bmp") {
      args.push("-f", "image2", "-c:v", "bmp");
    } else {
      throw new Error(`Unsupported image format: ${format}`);
    }

    args.push(output);

    send("tools:progress", {
      id: item.id,
      phase: "image",
      message: "处理中",
      percent: 35,
    });

    await spawnToolsFfmpeg(args);

    send("tools:progress", {
      id: item.id,
      phase: "image",
      message: "写入完成",
      percent: 95,
    });
  }

  function normalizeRegion(options = {}) {
    const x = Math.round(clampNumber(options.x, 0, 100000, 0));
    const y = Math.round(clampNumber(options.y, 0, 100000, 0));
    const width = Math.round(clampNumber(options.width, 1, 100000, 1));
    const height = Math.round(clampNumber(options.height, 1, 100000, 1));
    return { x, y, width, height };
  }

  function ffmpegColor(input) {
    const match = String(input || "").trim().match(/^#?([0-9a-f]{6})$/i);
    return match ? `0x${match[1]}` : "0x000000";
  }

  function watermarkFilter(options = {}) {
    const mode = ["blur", "mosaic", "cover", "crop"].includes(options.mode)
      ? options.mode
      : "blur";
    const { x, y, width, height } = normalizeRegion(options);

    if (mode === "blur") {
      return `[0:v]split=2[base][wm];[wm]crop=${width}:${height}:${x}:${y},boxblur=8:2[patch];[base][patch]overlay=${x}:${y}[v]`;
    }

    if (mode === "mosaic") {
      const smallW = Math.max(1, Math.floor(width / 12));
      const smallH = Math.max(1, Math.floor(height / 12));
      return `[0:v]split=2[base][wm];[wm]crop=${width}:${height}:${x}:${y},scale=${smallW}:${smallH}:flags=neighbor,scale=${width}:${height}:flags=neighbor[patch];[base][patch]overlay=${x}:${y}[v]`;
    }

    if (mode === "cover") {
      return `[0:v]drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${ffmpegColor(
        options.color
      )}@0.88:t=fill[v]`;
    }

    const side = ["top", "right", "bottom", "left"].includes(options.cropSide)
      ? options.cropSide
      : "right";
    if (side === "top") return `[0:v]crop=iw:ih-${y + height}:0:${y + height}[v]`;
    if (side === "bottom") return `[0:v]crop=iw:${y}:0:0[v]`;
    if (side === "left") return `[0:v]crop=iw-${x + width}:ih:${x + width}:0[v]`;
    return `[0:v]crop=${x}:ih:0:0[v]`;
  }

  async function runWatermark(input, output, options, item, totalDuration) {
    const args = [
      "-hide_banner",
      "-y",
      "-nostats",
      "-progress",
      "pipe:1",
      "-i",
      input,
      "-filter_complex",
      watermarkFilter(options),
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ];

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

  return {
    parseTimecode,
    formatTimecode,
    probeDuration,
    normalizeDeleteRanges,
    computeKeepRanges,
    runTrimAccurate,
    runTrimFast,
    cancelTrim: () => {
      if (activeTrimChild && !activeTrimChild.killed) activeTrimChild.kill("SIGKILL");
      return { ok: true };
    },
    generateThumbnail,
    runExtractAudio,
    runConvert,
    runImage,
    runWatermark,
    runGif,
    runConcat,
    cancelTools: () => {
      if (activeToolsChild && !activeToolsChild.killed) activeToolsChild.kill("SIGKILL");
      return { ok: true };
    },
  };
}

module.exports = { createTools };
