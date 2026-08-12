const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function createFfmpeg({ app, makeDownloadHeaders, send, logEvent }) {
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
      // options.countPattern lets callers tally matching stderr lines (used by the
      // post-download decode check) without buffering the whole ffmpeg log.
      let matchCount = 0;
      let lineTail = "";

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
        const text = chunk.toString();
        stderr += text;
        if (stderr.length > 6000) stderr = stderr.slice(-6000);

        if (options.countPattern) {
          const lines = (lineTail + text).split(/\r?\n/);
          lineTail = lines.pop() ?? "";
          for (const line of lines) {
            if (options.countPattern.test(line)) matchCount++;
          }
        }
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
        if (options.countPattern && lineTail && options.countPattern.test(lineTail)) {
          matchCount++;
        }

        if (code === 0) {
          logEvent("info", "ffmpeg completed", {
            mode: options.mode,
            filePath: options.filePath,
          });
          resolve({ outTimeMs, matchCount });
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

  // Reads the video parameters of a local file. `ffmpeg -i` without an output exits
  // non-zero by design, so this ignores the exit code and only parses stderr.
  function probeVideoParams(filePath) {
    return new Promise((resolve) => {
      const child = spawn(ffmpegPath(), ["-hide_banner", "-i", filePath], {
        stdio: ["ignore", "ignore", "pipe"],
      });

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });

      child.on("error", () => resolve(null));
      child.on("close", () => {
        const line = stderr.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*: Video: /.test(l));
        if (!line) {
          resolve(null);
          return;
        }

        const codec = line.match(/: Video: ([^\s,(]+)/)?.[1] ?? "";
        const profile = line.match(/: Video: [^\s,(]+ \(([^)]+)\)/)?.[1] ?? "";
        const resolution = line.match(/\b(\d{2,5}x\d{2,5})\b/)?.[1] ?? "";
        const pixFmt = line.match(/\b(yuv\w+|gbr\w+|nv\d+\w*)\b/)?.[1] ?? "";
        resolve({ codec, profile, resolution, pixFmt });
      });
    });
  }

  async function ffmpegHeaders(item) {
    const headers = await makeDownloadHeaders(item);
    return `${Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n")}\r\n`;
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

  return {
    ffmpegPath,
    safeFfmpegArgs,
    runFfmpeg,
    remuxMp4File,
    probeVideoParams,
    ffmpegHeaders,
    downloadFfmpegStream,
  };
}

module.exports = { createFfmpeg };
