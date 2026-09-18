const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const { pipeline } = require("stream/promises");

// Pin to a specific yt-dlp release for reproducible builds.
// Override with YT_DLP_TAG env var, or set to "latest" to fetch the latest release.
const RELEASE_TAG = process.env.YT_DLP_TAG || "latest";

// We ship yt-dlp's "onedir" builds: the executable plus an `_internal/` dir.
// The single-file builds unpack a ~72MB Python runtime into a fresh temp dir
// on *every* launch (~10s on macOS, and the dir leaks when the process is
// killed); the onedir build starts in ~0.3s.
//
// yt-dlp_macos.zip is universal (arm64 + x64), so both mac resource folders
// get the same contents and electron-builder's per-arch extraResources work.
const TARGETS = [
  { platform: "darwin", arch: "arm64", asset: "yt-dlp_macos.zip", exe: "yt-dlp_macos" },
  { platform: "darwin", arch: "x64", asset: "yt-dlp_macos.zip", exe: "yt-dlp_macos" },
  { platform: "win32", arch: "x64", asset: "yt-dlp_win.zip", exe: "yt-dlp.exe" },
];

const RESOURCES_ROOT = path.join(__dirname, "..", "resources", "yt-dlp");

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "video-download-build" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          res.resume();
          resolve(get(res.headers.location, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

// "latest" -> the concrete tag, read from the /releases/latest redirect, so we
// can record exactly which version got bundled.
function resolveTag(tag) {
  if (tag !== "latest") return Promise.resolve(tag);
  return new Promise((resolve, reject) => {
    https
      .get(
        "https://github.com/yt-dlp/yt-dlp/releases/latest",
        { headers: { "User-Agent": "video-download-build" } },
        (res) => {
          res.resume();
          const found = String(res.headers.location || "").match(/\/releases\/tag\/([^/?#]+)/);
          if (found) resolve(decodeURIComponent(found[1]));
          else reject(new Error(`Could not resolve latest yt-dlp tag (HTTP ${res.statusCode})`));
        }
      )
      .on("error", reject);
  });
}

function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", destDir]);
  }
}

function readVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, "version.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

// Archives already downloaded this run, by asset name (both mac targets share one).
const downloaded = new Map();

async function downloadAsset(tag, asset) {
  if (downloaded.has(asset)) return downloaded.get(asset);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${asset}`;
  console.log(`↓ ${url}`);
  await fs.promises.mkdir(RESOURCES_ROOT, { recursive: true });
  const zipPath = path.join(RESOURCES_ROOT, `.${asset}.partial`);
  await pipeline(await get(url), fs.createWriteStream(zipPath));
  downloaded.set(asset, zipPath);
  return zipPath;
}

async function fetchTarget(tag, target) {
  const destDir = path.join(RESOURCES_ROOT, `${target.platform}-${target.arch}`);
  const exePath = path.join(destDir, target.exe);
  if (fs.existsSync(exePath) && readVersion(destDir) === tag) {
    console.log(`✓ ${target.platform}-${target.arch} already at ${tag}`);
    return;
  }

  const zipPath = await downloadAsset(tag, target.asset);
  // Extract beside the old copy, then swap, so a failed run never leaves a
  // half-populated folder (this also clears out the old single-file binary).
  const staging = `${destDir}.staging`;
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(staging, { recursive: true });
  extractZip(zipPath, staging);
  if (!fs.existsSync(path.join(staging, target.exe))) {
    throw new Error(`${target.asset} did not contain ${target.exe}`);
  }
  if (target.platform !== "win32") await fs.promises.chmod(path.join(staging, target.exe), 0o755);
  await fs.promises.writeFile(path.join(staging, "version.txt"), `${tag}\n`);
  await fs.promises.rm(destDir, { recursive: true, force: true });
  await fs.promises.rename(staging, destDir);
  console.log(`  ${target.platform}-${target.arch} ready (${tag})`);
}

(async () => {
  // A Windows runner only builds Windows; macOS hosts may build both (`dist`).
  const targets = process.platform === "win32" ? TARGETS.filter((t) => t.platform === "win32") : TARGETS;
  try {
    const tag = await resolveTag(RELEASE_TAG);
    console.log(`yt-dlp release: ${tag}`);
    for (const target of targets) {
      try {
        await fetchTarget(tag, target);
      } catch (error) {
        console.error(`✗ ${target.platform}-${target.arch}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  } finally {
    for (const zipPath of downloaded.values()) await fs.promises.rm(zipPath, { force: true });
  }
})();
