const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { stageChromiumProfile, isChromiumBrowser } = require("./win-cookies");

const SUPPORTED_COOKIE_BROWSERS = new Set([
  "brave",
  "chrome",
  "chromium",
  "edge",
  "firefox",
  "opera",
  "safari",
  "vivaldi",
  "whale",
]);

function createYtdlp({ app, dialog, getMainWindow, ffmpegPath, send, logEvent }) {
  let cachedYtDlpPath;
  function ytDlpExeName() {
    return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  }
  function ytDlpUserPath() {
    return path.join(app.getPath("userData"), "bin", ytDlpExeName());
  }
  function ytDlpPath() {
    if (cachedYtDlpPath) return cachedYtDlpPath;
    if (process.env.YT_DLP_PATH) {
      cachedYtDlpPath = process.env.YT_DLP_PATH;
      return cachedYtDlpPath;
    }
    const exe = ytDlpExeName();
    // Prefer user-updated copy in userData over bundled binary.
    const userPath = ytDlpUserPath();
    if (fs.existsSync(userPath) && fs.statSync(userPath).size > 1_000_000) {
      cachedYtDlpPath = userPath;
      return cachedYtDlpPath;
    }
    if (app.isPackaged) {
      const resourcePath = path.join(process.resourcesPath, exe);
      if (fs.existsSync(resourcePath)) {
        cachedYtDlpPath = resourcePath;
        return cachedYtDlpPath;
      }
    } else {
      const archDir = `${process.platform}-${process.arch}`;
      const devPath = path.join(__dirname, "..", "resources", "yt-dlp", archDir, exe);
      if (fs.existsSync(devPath)) {
        cachedYtDlpPath = devPath;
        return cachedYtDlpPath;
      }
    }
    cachedYtDlpPath = exe;
    return cachedYtDlpPath;
  }

  function runYtDlp(args, { onLine, signal } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killed = false;

      if (signal) {
        signal.kill = () => {
          killed = true;
          if (!child.killed) child.kill("SIGKILL");
        };
      }

      const handleLine = (line) => {
        if (onLine) onLine(line);
      };

      let buf = "";
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        buf += text;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 80000) stderr = stderr.slice(-80000);
      });
      child.on("error", (error) => {
        if (error.code === "ENOENT") {
          reject(
            new Error(
              "yt-dlp 未找到。请安装 yt-dlp（pip install yt-dlp 或 brew install yt-dlp），或设置 YT_DLP_PATH 环境变量。"
            )
          );
        } else {
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (buf) handleLine(buf);
        if (killed) {
          reject(new Error("已取消"));
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
          reject(new Error(tail || `yt-dlp 退出码 ${code}`));
        }
      });
    });
  }

  function summarizeFormat(f) {
    const hasV = f.vcodec && f.vcodec !== "none";
    const hasA = f.acodec && f.acodec !== "none";
    let kind = "other";
    if (hasV && hasA) kind = "combined";
    else if (hasV) kind = "video";
    else if (hasA) kind = "audio";

    return {
      formatId: f.format_id,
      ext: f.ext,
      kind,
      resolution: f.resolution || (f.width && f.height ? `${f.width}x${f.height}` : ""),
      width: f.width || 0,
      height: f.height || 0,
      fps: f.fps || 0,
      vcodec: hasV ? f.vcodec : "",
      acodec: hasA ? f.acodec : "",
      abr: f.abr || 0,
      tbr: f.tbr || 0,
      filesize: f.filesize || f.filesize_approx || 0,
      formatNote: f.format_note || "",
      protocol: f.protocol || "",
    };
  }

  // Resolve a `--cookies-from-browser` value into a spec yt-dlp can actually
  // use, plus a `release()` for whatever temp state it needed. On Windows we
  // hand yt-dlp our own unlocked copy of the Chromium profile, because its
  // internal copy step fails while the browser is running (yt-dlp#7271).
  async function prepareCookieSpec(value) {
    const noop = { spec: "", release: async () => {} };
    const raw = String(value || "").trim();
    if (!raw) return noop;
    // An explicit spec (profile / keyring / container) is passed through as-is.
    if (/[:+]/.test(raw)) return { ...noop, spec: raw };

    const browser = raw.toLowerCase().replace(/[^a-z]/g, "");
    if (!SUPPORTED_COOKIE_BROWSERS.has(browser)) {
      throw new Error(`不支持从该浏览器读取 Cookie: ${raw}`);
    }
    if (process.platform !== "win32" || !isChromiumBrowser(browser)) {
      return { ...noop, spec: browser };
    }

    try {
      const staged = await stageChromiumProfile(browser);
      if (staged) {
        logEvent("info", "Staged a private copy of the browser profile", { browser, dir: staged.dir });
        return {
          spec: staged.spec,
          release: () => fs.promises.rm(staged.dir, { recursive: true, force: true }).catch(() => {}),
        };
      }
    } catch (error) {
      logEvent("warn", "Failed to stage browser profile copy; using browser name", {
        browser,
        error: error.message,
      });
    }
    return { ...noop, spec: browser };
  }

  // yt-dlp's raw cookie errors are opaque; point at the actual way out.
  function describeCookieError(error, browser) {
    const message = String(error?.message || "");
    if (!browser) return error;

    // Chromium 127+ on Windows wraps cookies in App-Bound Encryption (v20): the
    // key lives behind a system service that only the browser itself may ask,
    // so no amount of file copying helps. yt-dlp cannot read these at all.
    if (/DPAPI|10927|failed to decrypt|app-?bound/i.test(message)) {
      return new Error(
        `${browser} 的 Cookie 已被 Windows 应用绑定加密（Chromium 127+），yt-dlp 无法解密——这不是配置问题，换浏览器版本也无效。` +
          `请把「登录 Cookie」改选「应用内登录（扫码）」，在应用内登录一次即可。原始错误：${message}`
      );
    }
    if (/could not copy|permission|being used by another process|cookie database/i.test(message)) {
      return new Error(
        `无法读取 ${browser} 的 Cookie（数据库被占用或无权访问）。请完全退出 ${browser}（含后台进程）后重试；` +
          `若仍失败，请改选「应用内登录（扫码）」。原始错误：${message}`
      );
    }
    return error;
  }

  async function listFormats(payload) {
    const url = typeof payload === "string" ? payload : payload?.url;
    const cookiesFromBrowser = typeof payload === "object" ? payload?.cookiesFromBrowser : "";
    if (!url) throw new Error("URL is required.");
    logEvent("info", "yt-dlp listing formats", { url, cookiesFromBrowser });

    const args = ["-J", "--no-warnings", "--no-playlist"];
    const cookies = await prepareCookieSpec(cookiesFromBrowser);
    if (cookies.spec) {
      args.push("--cookies-from-browser", cookies.spec);
    } else if (payload?.cookiesFile) {
      args.push("--cookies", payload.cookiesFile);
    }
    if (payload?.userAgent) {
      args.push("--user-agent", payload.userAgent);
    }
    args.push(url);

    let stdout;
    try {
      ({ stdout } = await runYtDlp(args));
    } catch (error) {
      throw describeCookieError(error, cookiesFromBrowser);
    } finally {
      await cookies.release();
    }

    let json;
    try {
      json = JSON.parse(stdout);
    } catch (error) {
      throw new Error("解析 yt-dlp 输出失败：" + error.message);
    }

    const formats = (json.formats || [])
      .filter((f) => f.format_id && f.protocol !== "mhtml")
      .map(summarizeFormat);

    return {
      title: json.title || "",
      uploader: json.uploader || json.channel || "",
      duration: json.duration || 0,
      thumbnail: json.thumbnail || "",
      webpageUrl: json.webpage_url || url,
      extractor: json.extractor_key || json.extractor || "",
      formats,
    };
  }

  async function pickOutput(options) {
    const ext = options?.ext || "mp4";
    const suggested = options?.suggestedName || `download-${Date.now()}.${ext}`;
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: "保存为",
      defaultPath: path.join(app.getPath("downloads"), suggested),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { filePath: result.filePath };
  }

  let activeDlpSignal = null;

  async function download(payload) {
    const { url, format, output, mergeFormat } = payload || {};
    if (!url) throw new Error("URL is required.");
    if (!output) throw new Error("Output path is required.");

    const id = `dlp-${Date.now()}`;
    send("dlp:status", { id, state: "running" });
    logEvent("info", "yt-dlp downloading", { url, format, output });

    const ext = path.extname(output).replace(/^\./, "").toLowerCase() || "mp4";
    const concurrency = Number(payload?.concurrency) > 0 ? Number(payload.concurrency) : 8;
    // Audio-only quick extraction (e.g. download as MP3).
    const AUDIO_FORMATS = new Set(["mp3", "m4a", "aac", "flac", "wav", "opus", "vorbis"]);
    const audioFormat = AUDIO_FORMATS.has(String(payload?.audioFormat || "").toLowerCase())
      ? String(payload.audioFormat).toLowerCase()
      : "";
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--no-mtime",
      "--newline",
      "--ffmpeg-location",
      ffmpegPath(),
      // Speed: download HLS/DASH fragments in parallel
      "-N",
      String(concurrency),
      // Speed: chunk single-file HTTP downloads so slow sources don't stall one socket
      "--http-chunk-size",
      "10M",
      // Resilience against transient errors / throttling
      "--retries",
      "10",
      "--fragment-retries",
      "10",
      "-f",
      audioFormat ? "ba/b" : format || "bv*+ba/b",
      "-o",
      output,
    ];
    if (audioFormat) {
      // Extract the audio track and transcode to the requested container.
      args.push("-x", "--audio-format", audioFormat, "--audio-quality", "0");
    }
    const cookies = await prepareCookieSpec(payload?.cookiesFromBrowser);
    if (cookies.spec) {
      args.push("--cookies-from-browser", cookies.spec);
    } else if (payload?.cookiesFile) {
      args.push("--cookies", payload.cookiesFile);
    }
    if (payload?.userAgent) {
      args.push("--user-agent", payload.userAgent);
    }
    if (payload?.referer) {
      args.push("--referer", payload.referer);
    }
    if (!audioFormat && (mergeFormat || ext === "mp4" || ext === "mkv" || ext === "webm")) {
      args.push("--merge-output-format", mergeFormat || ext);
    }
    args.push(url);

    const signal = {};
    activeDlpSignal = signal;

    try {
      await runYtDlp(args, {
        signal,
        onLine: (line) => {
          if (!line) return;
          const dl = line.match(/^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);
          if (dl) {
            send("dlp:progress", {
              id,
              percent: Number(dl[1]),
              total: dl[2],
              speed: dl[3] || "",
              eta: dl[4] || "",
              phase: "downloading",
            });
            return;
          }
          if (/^\[Merger\]/.test(line)) {
            send("dlp:progress", { id, phase: "merging" });
            return;
          }
          if (/^\[ExtractAudio\]/.test(line) || /^\[ffmpeg\]/.test(line)) {
            send("dlp:progress", { id, phase: "post-processing" });
            return;
          }
        },
      });

      if (!fs.existsSync(output)) {
        const dir = path.dirname(output);
        const stem = path.parse(output).name;
        const candidates = (await fs.promises.readdir(dir)).filter((f) => f.startsWith(stem));
        if (candidates.length > 0) {
          const found = path.join(dir, candidates[0]);
          send("dlp:status", { id, state: "done", filePath: found });
          return { ok: true, filePath: found };
        }
        throw new Error("下载完成但未找到输出文件");
      }

      const stat = await fs.promises.stat(output);
      send("dlp:status", { id, state: "done", filePath: output });
      logEvent("info", "yt-dlp completed", { output, size: stat.size });
      return { ok: true, filePath: output, size: stat.size };
    } catch (rawError) {
      const error = describeCookieError(rawError, payload?.cookiesFromBrowser);
      send("dlp:status", { id, state: "error", message: error.message });
      logEvent("error", "yt-dlp failed", { error: error.message });
      throw error;
    } finally {
      activeDlpSignal = null;
      await cookies.release();
    }
  }

  async function cancel() {
    if (activeDlpSignal?.kill) activeDlpSignal.kill();
    return { ok: true };
  }

  function compareYtDlpVersions(a, b) {
    // yt-dlp tags are date-based: "2026.01.15" or "2026.01.15.123456".
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const da = pa[i] || 0;
      const db = pb[i] || 0;
      if (da !== db) return da < db ? -1 : 1;
    }
    return 0;
  }

  async function getCurrentYtDlpVersion() {
    try {
      const { stdout } = await runYtDlp(["--version"]);
      return stdout.trim().split("\n").pop().trim();
    } catch {
      return "";
    }
  }

  const RELEASES_URL = "https://github.com/yt-dlp/yt-dlp/releases";
  const UA = "video-download-app";

  // The /releases/latest page 302s to /releases/tag/<version>. Reading that tag
  // costs no API quota, unlike api.github.com which rate-limits unauthenticated
  // callers to 60 requests/hour per IP (surfacing as HTTP 403).
  async function getLatestTagViaRedirect() {
    const res = await fetch(`${RELEASES_URL}/latest`, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    const location = res.headers.get("location") || "";
    const tag = location.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
    if (!tag) throw new Error(`GitHub ${res.status}`);
    return { tag: decodeURIComponent(tag), htmlUrl: `${RELEASES_URL}/tag/${tag}` };
  }

  async function getLatestTagViaApi() {
    const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
    // A token lifts the anonymous rate limit; optional.
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", { headers });
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 429 ? "（请求频率超限或被网络策略拦截）" : "";
      throw new Error(`GitHub API ${res.status}${hint}`);
    }
    const json = await res.json();
    return { tag: String(json.tag_name || "").trim(), htmlUrl: json.html_url };
  }

  let cachedRelease = null;
  const RELEASE_CACHE_MS = 60 * 60 * 1000;

  async function getLatestYtDlpRelease() {
    if (cachedRelease && Date.now() - cachedRelease.at < RELEASE_CACHE_MS) {
      return cachedRelease.value;
    }
    let value;
    try {
      value = await getLatestTagViaRedirect();
    } catch (error) {
      logEvent("warn", "Release redirect lookup failed, falling back to GitHub API", {
        error: error.message,
      });
      value = await getLatestTagViaApi();
    }
    cachedRelease = { at: Date.now(), value };
    return value;
  }

  function ytDlpAssetName() {
    if (process.platform === "win32") return "yt-dlp.exe";
    if (process.platform === "darwin") return "yt-dlp_macos";
    return "yt-dlp";
  }

  let activeYtDlpUpdate = null;

  async function checkUpdate() {
    try {
      const [current, latest] = await Promise.all([
        getCurrentYtDlpVersion(),
        getLatestYtDlpRelease(),
      ]);
      const hasUpdate = current && latest.tag ? compareYtDlpVersions(current, latest.tag) < 0 : false;
      return { ok: true, current, latest: latest.tag, hasUpdate, htmlUrl: latest.htmlUrl };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function update() {
    if (activeYtDlpUpdate) {
      return { ok: false, error: "已有进行中的更新任务" };
    }
    const controller = new AbortController();
    activeYtDlpUpdate = controller;
    try {
      const asset = ytDlpAssetName();
      const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
      const destPath = ytDlpUserPath();
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      const tmpPath = `${destPath}.partial`;

      send("dlp:updateProgress", { phase: "start", percent: 0 });
      logEvent("info", "yt-dlp update: downloading", { url });

      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      let received = 0;
      let lastEmitted = 0;

      const out = fs.createWriteStream(tmpPath);
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!out.write(value)) await new Promise((r) => out.once("drain", r));
        const now = Date.now();
        if (now - lastEmitted > 150) {
          lastEmitted = now;
          send("dlp:updateProgress", {
            phase: "download",
            received,
            total,
            percent: total ? Math.min(99, (received / total) * 100) : 0,
          });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

      if (fs.statSync(tmpPath).size < 1_000_000) {
        throw new Error("下载文件异常(过小)");
      }
      await fs.promises.rename(tmpPath, destPath);
      if (process.platform !== "win32") {
        await fs.promises.chmod(destPath, 0o755);
      }
      cachedYtDlpPath = undefined;
      const current = await getCurrentYtDlpVersion();
      send("dlp:updateProgress", { phase: "done", percent: 100, current });
      logEvent("info", "yt-dlp update: done", { path: destPath, version: current });
      return { ok: true, current, path: destPath };
    } catch (error) {
      send("dlp:updateProgress", { phase: "error", error: error.message });
      logEvent("error", "yt-dlp update failed", { error: error.message });
      return { ok: false, error: error.message };
    } finally {
      activeYtDlpUpdate = null;
    }
  }

  // Dump a browser's cookie jar to a temporary Netscape file using yt-dlp's
  // robust per-platform decryption, and return the file path. yt-dlp exits
  // non-zero when given no URL, but still writes the jar — so we ignore the
  // exit code and instead verify the file was produced.
  async function exportBrowserCookies(browser) {
    const safe = String(browser || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!SUPPORTED_COOKIE_BROWSERS.has(safe)) {
      throw new Error(`不支持从该浏览器读取 Cookie: ${browser}`);
    }
    const outFile = path.join(os.tmpdir(), `vf-cookies-${Date.now()}-${process.pid}.txt`);
    const cookies = await prepareCookieSpec(safe);
    const args = ["--cookies-from-browser", cookies.spec, "--cookies", outFile, "--no-warnings", "--simulate"];
    logEvent("info", "Exporting cookies from browser", { browser: safe });
    let lastError = null;
    try {
      await runYtDlp(args);
    } catch (error) {
      // Expected: "You must provide at least one URL" -> exit code 2.
      lastError = error;
      logEvent("debug", "yt-dlp cookie export exited non-zero (expected)", { error: error.message });
    } finally {
      await cookies.release();
    }
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
      // Only surface yt-dlp's own message when we recognised it — otherwise it
      // is the harmless "You must provide at least one URL" exit.
      const described = lastError ? describeCookieError(lastError, safe) : null;
      if (described && described !== lastError) throw described;
      throw new Error(`无法从 ${safe} 读取 Cookie（可能未安装、未登录，或需要授权访问）。`);
    }
    return outFile;
  }

  return {
    listFormats,
    pickOutput,
    download,
    cancel,
    checkUpdate,
    update,
    exportBrowserCookies,
    supportedCookieBrowsers: () => Array.from(SUPPORTED_COOKIE_BROWSERS),
  };
}

module.exports = { createYtdlp };
