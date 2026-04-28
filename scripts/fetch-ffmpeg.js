const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");

const RELEASE_TAG = "b6.1.1";
const BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE_TAG}`;

const TARGETS = [
  { platform: "darwin", arch: "arm64", out: "darwin-arm64/ffmpeg" },
  { platform: "darwin", arch: "x64", out: "darwin-x64/ffmpeg" },
  { platform: "win32", arch: "x64", out: "win32-x64/ffmpeg.exe" },
];

const RESOURCES_ROOT = path.join(__dirname, "..", "resources", "ffmpeg");

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

  const url = `${BASE_URL}/ffmpeg-${target.platform}-${target.arch}.gz`;
  console.log(`↓ ${target.platform}-${target.arch}  ${url}`);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  const tmpPath = `${destPath}.partial`;
  const res = await get(url);
  await pipeline(res, zlib.createGunzip(), fs.createWriteStream(tmpPath));
  await fs.promises.rename(tmpPath, destPath);
  if (target.platform !== "win32") {
    await fs.promises.chmod(destPath, 0o755);
  }
  const size = fs.statSync(destPath).size;
  console.log(`  done (${(size / 1024 / 1024).toFixed(1)}MB)`);
}

(async () => {
  for (const target of TARGETS) {
    try {
      await fetchTarget(target);
    } catch (error) {
      console.error(`✗ ${target.platform}-${target.arch}: ${error.message}`);
      process.exitCode = 1;
    }
  }
})();
