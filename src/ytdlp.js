const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { stageChromiumProfile, isChromiumBrowser } = require("./win-cookies");
const { bindChildToTask } = require("./task-context");

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
  // yt-dlp ships as a PyInstaller "onedir" build: an executable next to an
  // `_internal/` folder. (The one-file build re-extracts ~72MB of Python into a
  // new temp dir on every launch: ~10s each time on macOS, and a leaked temp
  // dir whenever the process is killed.)
  const ONEDIR = {
    darwin: { asset: "yt-dlp_macos.zip", exe: "yt-dlp_macos" },
    win32: { asset: "yt-dlp_win.zip", exe: "yt-dlp.exe" },
    linux: { asset: "yt-dlp_linux.zip", exe: "yt-dlp_linux" },
  }[process.platform];

  let cachedYtDlpPath;
  // In-app updates install here, taking precedence over the bundled copy.
  function ytDlpUserDir() {
    return path.join(app.getPath("userData"), "yt-dlp");
  }
  // Where in-app updates used to put the one-file build.
  function legacyYtDlpPath() {
    return path.join(app.getPath("userData"), "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  }
  function bundledYtDlpDir() {
    return app.isPackaged
      ? path.join(process.resourcesPath, "yt-dlp")
      : path.join(__dirname, "..", "resources", "yt-dlp", `${process.platform}-${process.arch}`);
  }
  function ytDlpPath() {
    if (cachedYtDlpPath) return cachedYtDlpPath;
    if (process.env.YT_DLP_PATH) {
      cachedYtDlpPath = process.env.YT_DLP_PATH;
      return cachedYtDlpPath;
    }
    const candidates = [
      ONEDIR && path.join(ytDlpUserDir(), ONEDIR.exe),
      legacyYtDlpPath(),
      ONEDIR && path.join(bundledYtDlpDir(), ONEDIR.exe),
    ].filter(Boolean);
    cachedYtDlpPath = candidates.find((p) => fs.existsSync(p)) || "yt-dlp";
    return cachedYtDlpPath;
  }

  function readBundledVersion() {
    try {
      return fs.readFileSync(path.join(bundledYtDlpDir(), "version.txt"), "utf8").trim();
    } catch {
      return "";
    }
  }

  // An earlier in-app update may have left the slow one-file build in
  // userData/bin, which would shadow the bundled onedir copy. Drop it once the
  // onedir build is at least as new; keep it (until the next update) if it is
  // still the newer one. Runs in the background at startup.
  async function retireLegacyYtDlp() {
    const legacy = legacyYtDlpPath();
    if (process.env.YT_DLP_PATH || !fs.existsSync(legacy)) return;
    let replacement = fs.existsSync(path.join(ytDlpUserDir(), ONEDIR?.exe || "")) ? "installed" : "";
    if (!replacement) {
      const bundled = readBundledVersion();
      const legacyVersion = bundled ? await versionOf(legacy) : "";
      if (bundled && legacyVersion && compareYtDlpVersions(bundled, legacyVersion) >= 0) replacement = bundled;
    }
    if (!replacement) return;
    await fs.promises.rm(path.dirname(legacy), { recursive: true, force: true });
    if (cachedYtDlpPath === legacy) cachedYtDlpPath = undefined;
    logEvent("info", "Removed legacy one-file yt-dlp", { legacy, replacement });
  }

  function versionOf(exePath) {
    return new Promise((resolve) => {
      execFile(exePath, ["--version"], { timeout: 120000 }, (error, stdout) => {
        resolve(error ? "" : String(stdout).trim().split("\n").pop().trim());
      });
    });
  }

  // The bundled yt-dlp is a PyInstaller one-file build: the process we spawn
  // is only a bootloader that runs the real yt-dlp as its child, which in turn
  // spawns ffmpeg. Killing just the bootloader orphans the rest, and they keep
  // downloading in the background. So kill the whole tree.
  function killTree(child) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      return;
    }
    try {
      // Negative pid = the process group created by `detached: true`.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }

  // `collectStdout: false` for long downloads, whose progress output is only
  // needed line by line and would otherwise pile up for the whole run.
  function runYtDlp(args, { onLine, collectStdout = true } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(ytDlpPath(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group on POSIX so killTree can reach every descendant.
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let killed = false;

      // Inside a queued task, canceling it kills the whole yt-dlp tree.
      bindChildToTask(child, () => {
        killed = true;
        killTree(child);
      });

      const handleLine = (line) => {
        if (onLine) onLine(line);
      };

      let buf = "";
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        if (collectStdout) stdout += text;
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

  // Run `yt-dlp -J` and parse its JSON. `--flat-playlist` keeps playlist URLs
  // cheap: entries come back as bare references instead of each being fully
  // extracted (a 700-part course would otherwise take minutes).
  async function probeJson(payload, playlistArgs) {
    const url = typeof payload === "string" ? payload : payload?.url;
    const cookiesFromBrowser = typeof payload === "object" ? payload?.cookiesFromBrowser : "";
    if (!url) throw new Error("URL is required.");

    const args = ["-J", "--no-warnings", "--flat-playlist", ...playlistArgs];
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

    try {
      return { url, json: JSON.parse(stdout) };
    } catch (error) {
      throw new Error("解析 yt-dlp 输出失败：" + error.message);
    }
  }

  function summarizePlaylist(url, json) {
    const entries = (json.entries || []).filter(Boolean).map((e, i) => {
      const index = i + 1;
      const direct = [e.url, e.webpage_url].find((u) => /^https?:\/\//i.test(u || ""));
      return {
        index,
        title: e.title || "",
        duration: e.duration || 0,
        uploader: e.uploader || e.channel || "",
        // Entries without a standalone URL are fetched as item N of the list.
        url: direct || url,
        playlistItem: direct ? 0 : index,
      };
    });
    return {
      isPlaylist: true,
      title: json.title || "",
      uploader: json.uploader || json.channel || "",
      webpageUrl: json.webpage_url || url,
      extractor: json.extractor_key || json.extractor || "",
      entries,
    };
  }

  async function listFormats(payload) {
    logEvent("info", "yt-dlp listing formats", { url: payload?.url || payload });
    const { url, json } = await probeJson(payload, ["--no-playlist"]);
    // A pure playlist URL (no single video in it) is a playlist regardless.
    if (json._type === "playlist") return summarizePlaylist(url, json);

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

  // Expand a URL as a playlist / collection / multi-part video.
  async function listPlaylist(payload) {
    logEvent("info", "yt-dlp listing playlist", { url: payload?.url || payload });
    const { url, json } = await probeJson(payload, ["--yes-playlist"]);
    if (json._type !== "playlist") {
      throw new Error("该链接不是播放列表 / 合集（只有单个视频），请取消勾选后解析");
    }
    return summarizePlaylist(url, json);
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

  async function pickDir() {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择保存文件夹",
      defaultPath: app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { dirPath: result.filePaths[0] };
  }

  const AUDIO_FORMATS = new Set(["mp3", "m4a", "aac", "flac", "wav", "opus", "vorbis"]);
  let printFileSeq = 0;

  // Download one item. Either `output` (an exact file path) or `outputDir`
  // (+ optional `namePrefix`, letting yt-dlp name the file from the title) must
  // be given. `playlistItem` downloads that 1-based entry of `url` as a
  // playlist, for entries yt-dlp exposes no standalone URL for. `tempDir`, if
  // given, receives every intermediate file (`.part`, fragments, unmerged
  // streams) so nothing half-done ever lands next to the user's files.
  async function runDownload(payload, { onProgress } = {}) {
    const { url, format, output, outputDir, mergeFormat, playlistItem } = payload || {};
    if (!url) throw new Error("URL is required.");
    if (!output && !outputDir) throw new Error("Output path is required.");

    logEvent("info", "yt-dlp downloading", { url, format, output, outputDir, playlistItem });

    const concurrency = Number(payload?.concurrency) > 0 ? Number(payload.concurrency) : 8;
    // Audio-only quick extraction (e.g. download as MP3).
    const audioFormat = AUDIO_FORMATS.has(String(payload?.audioFormat || "").toLowerCase())
      ? String(payload.audioFormat).toLowerCase()
      : "";
    // yt-dlp only honors `-P temp:` for a template relative to `-P home:`.
    // An exact name is still parsed as a template, so escape its `%`.
    const homeDir = output ? path.dirname(output) : outputDir;
    const template = output
      ? path.basename(output).replace(/%/g, "%%")
      : `${String(payload?.namePrefix || "").replace(/%/g, "%%")}%(title).150B.%(ext)s`;
    const tempDir = payload?.tempDir || "";
    const ext = output ? path.extname(output).replace(/^\./, "").toLowerCase() || "mp4" : "mp4";
    // yt-dlp reports the final path (after merge / audio extraction) here.
    const printFile = path.join(
      tempDir || app.getPath("temp"),
      `vf-dlp-${process.pid}-${Date.now()}-${++printFileSeq}.txt`
    );

    const args = [
      ...(playlistItem ? ["--yes-playlist", "--playlist-items", String(playlistItem)] : ["--no-playlist"]),
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
      "--print-to-file",
      "after_move:filepath",
      printFile,
      "-P",
      `home:${homeDir}`,
      ...(tempDir ? ["-P", `temp:${tempDir}`] : []),
      "-o",
      template,
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

    const progress = onProgress || (() => {});
    try {
      await runYtDlp(args, {
        collectStdout: false,
        onLine: (line) => {
          if (!line) return;
          const dl = line.match(/^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);
          if (dl) {
            progress({
              percent: Number(dl[1]),
              total: dl[2],
              speed: dl[3] || "",
              eta: dl[4] || "",
              phase: "downloading",
            });
            return;
          }
          if (/^\[Merger\]/.test(line)) {
            progress({ phase: "merging" });
            return;
          }
          if (/^\[ExtractAudio\]/.test(line) || /^\[ffmpeg\]/.test(line)) {
            progress({ phase: "post-processing" });
          }
        },
      });

      const printed = await fs.promises.readFile(printFile, "utf8").catch(() => "");
      const filePath = printed.split(/\r?\n/).filter(Boolean).pop() || output || "";
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error("下载完成但未找到输出文件");
      }
      const stat = await fs.promises.stat(filePath);
      logEvent("info", "yt-dlp completed", { filePath, size: stat.size });
      return { ok: true, filePath, size: stat.size };
    } catch (rawError) {
      const error = describeCookieError(rawError, payload?.cookiesFromBrowser);
      logEvent("error", "yt-dlp failed", { url, error: error.message });
      throw error;
    } finally {
      await fs.promises.rm(printFile, { force: true }).catch(() => {});
      await cookies.release();
    }
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

  function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const done = (error) => (error ? reject(new Error(`解压失败：${error.message}`)) : resolve());
      if (process.platform === "win32") {
        const q = (p) => `'${p.replace(/'/g, "''")}'`;
        execFile(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(destDir)} -Force`],
          done
        );
      } else if (process.platform === "darwin") {
        execFile("ditto", ["-x", "-k", zipPath, destDir], done);
      } else {
        execFile("unzip", ["-q", "-o", zipPath, "-d", destDir], done);
      }
    });
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
    if (!ONEDIR) return { ok: false, error: "当前平台不支持应用内更新" };
    const controller = new AbortController();
    activeYtDlpUpdate = controller;
    const userData = app.getPath("userData");
    const zipPath = path.join(userData, "yt-dlp-update.zip.partial");
    const staging = path.join(userData, "yt-dlp.staging");
    try {
      const { tag } = await getLatestYtDlpRelease();
      const url = `${RELEASES_URL}/download/${tag}/${ONEDIR.asset}`;
      send("dlp:updateProgress", { phase: "start", percent: 0 });
      logEvent("info", "yt-dlp update: downloading", { url });

      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      let received = 0;
      let lastEmitted = 0;

      const out = fs.createWriteStream(zipPath);
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
      if (total && received !== total) throw new Error(`下载不完整 (${received}/${total})`);

      // Unpack and prove the new build runs before touching the current one.
      // (macOS scans a freshly unpacked build once, so this first run is slow.)
      send("dlp:updateProgress", { phase: "install" });
      await fs.promises.rm(staging, { recursive: true, force: true });
      await fs.promises.mkdir(staging, { recursive: true });
      await extractZip(zipPath, staging);
      const stagedExe = path.join(staging, ONEDIR.exe);
      if (!fs.existsSync(stagedExe)) throw new Error(`压缩包里没有 ${ONEDIR.exe}`);
      if (process.platform !== "win32") await fs.promises.chmod(stagedExe, 0o755);
      const current = await versionOf(stagedExe);
      if (!current) throw new Error("新版本无法运行，已保留当前版本");

      const destDir = ytDlpUserDir();
      const retired = `${destDir}.old-${Date.now()}`;
      if (fs.existsSync(destDir)) {
        try {
          await fs.promises.rename(destDir, retired);
        } catch (error) {
          // Windows won't rename a folder whose exe is running.
          throw new Error(`当前版本正在使用中，请等 yt-dlp 任务结束后再更新（${error.code || error.message}）`);
        }
      }
      await fs.promises.rename(staging, destDir);
      await fs.promises.rm(retired, { recursive: true, force: true }).catch(() => {});
      // The onedir install supersedes any one-file build from older versions.
      await fs.promises.rm(path.dirname(legacyYtDlpPath()), { recursive: true, force: true }).catch(() => {});
      cachedYtDlpPath = undefined;

      send("dlp:updateProgress", { phase: "done", percent: 100, current });
      logEvent("info", "yt-dlp update: done", { path: destDir, version: current });
      return { ok: true, current, path: destDir };
    } catch (error) {
      send("dlp:updateProgress", { phase: "error", error: error.message });
      logEvent("error", "yt-dlp update failed", { error: error.message });
      return { ok: false, error: error.message };
    } finally {
      await fs.promises.rm(zipPath, { force: true }).catch(() => {});
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      activeYtDlpUpdate = null;
    }
  }

  return {
    listFormats,
    listPlaylist,
    pickOutput,
    pickDir,
    runDownload,
    retireLegacyYtDlp,
    checkUpdate,
    update,
    supportedCookieBrowsers: () => Array.from(SUPPORTED_COOKIE_BROWSERS),
  };
}

module.exports = { createYtdlp };
