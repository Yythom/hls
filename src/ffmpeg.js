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
    ffmpegHeaders,
    downloadFfmpegStream,
  };
}

module.exports = { createFfmpeg };
