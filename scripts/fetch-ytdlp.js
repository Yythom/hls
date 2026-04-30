const fs = require("fs");
const path = require("path");
const https = require("https");
const { pipeline } = require("stream/promises");

// Pin to a specific yt-dlp release for reproducible builds.
// Override with YT_DLP_TAG env var, or set to "latest" to fetch the latest release.
const RELEASE_TAG = process.env.YT_DLP_TAG || "latest";

const TAG_PATH = RELEASE_TAG === "latest" ? "latest/download" : `download/${RELEASE_TAG}`;
const BASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/${TAG_PATH}`;

// yt-dlp_macos is a universal binary (arm64 + x64). We copy it into both
// arch-specific resource folders so electron-builder's per-arch extraResources
// keep working without changes.
const TARGETS = [
  { platform: "darwin", arch: "arm64", asset: "yt-dlp_macos", out: "darwin-arm64/yt-dlp" },
  { platform: "darwin", arch: "x64", asset: "yt-dlp_macos", out: "darwin-x64/yt-dlp" },
  { platform: "win32", arch: "x64", asset: "yt-dlp.exe", out: "win32-x64/yt-dlp.exe" },
];

const RESOURCES_ROOT = path.join(__dirname, "..", "resources", "yt-dlp");

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
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

async function fetchTarget(target) {
  const destPath = path.join(RESOURCES_ROOT, target.out);
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1_000_000) {
    console.log(`✓ ${target.platform}-${target.arch} already present (${destPath})`);
    return;
  }

  const url = `${BASE_URL}/${target.asset}`;
  console.log(`↓ ${target.platform}-${target.arch}  ${url}`);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  const tmpPath = `${destPath}.partial`;
  const res = await get(url);
  await pipeline(res, fs.createWriteStream(tmpPath));
  await fs.promises.rename(tmpPath, destPath);
  if (target.platform !== "win32") {
    await fs.promises.chmod(destPath, 0o755);
  }
  const size = fs.statSync(destPath).size;
  console.log(`  done (${(size / 1024 / 1024).toFixed(1)}MB)`);
}

(async () => {
  console.log(`yt-dlp release: ${RELEASE_TAG}`);
  for (const target of TARGETS) {
    try {
      await fetchTarget(target);
    } catch (error) {
      console.error(`✗ ${target.platform}-${target.arch}: ${error.message}`);
      process.exitCode = 1;
    }
  }
})();
