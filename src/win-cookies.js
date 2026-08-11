const fs = require("fs");
const os = require("os");
const path = require("path");

// On Windows, yt-dlp reads Chromium-based cookies by copying the profile's
// `Cookies` SQLite file to a temp dir first. That copy uses CopyFileW, which
// fails with a PermissionError while the browser is running (or when the
// profile lives under a redirected/protected folder), surfacing as:
//   "ERROR: Could not copy Chrome cookie database" (yt-dlp#7271)
//
// Node's file handles are opened with FILE_SHARE_READ|WRITE|DELETE, so reading
// the very same locked file usually succeeds. We therefore stage our own copy
// of the profile and hand yt-dlp an explicit profile path instead of a bare
// browser name — yt-dlp then reads our unlocked copy.

// Relative to a base env var; `userData` marks the "User Data" style layout
// where profiles are subdirectories and `Local State` sits one level up.
const BROWSER_DIRS = {
  chrome: ["LOCALAPPDATA", ["Google", "Chrome", "User Data"]],
  chromium: ["LOCALAPPDATA", ["Chromium", "User Data"]],
  edge: ["LOCALAPPDATA", ["Microsoft", "Edge", "User Data"]],
  brave: ["LOCALAPPDATA", ["BraveSoftware", "Brave-Browser", "User Data"]],
  vivaldi: ["LOCALAPPDATA", ["Vivaldi", "User Data"]],
  whale: ["LOCALAPPDATA", ["Naver", "Naver Whale", "User Data"]],
  opera: ["APPDATA", ["Opera Software", "Opera Stable"]],
};

function browserRoot(browser) {
  const entry = BROWSER_DIRS[browser];
  if (!entry) return "";
  const base = process.env[entry[0]];
  if (!base) return "";
  const dir = path.join(base, ...entry[1]);
  return fs.existsSync(dir) ? dir : "";
}

function statTimeOrZero(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Cookie DB lives at <profile>/Network/Cookies on current Chromium versions,
// and at <profile>/Cookies on older ones.
function cookieDbIn(profileDir) {
  for (const rel of [path.join("Network", "Cookies"), "Cookies"]) {
    const file = path.join(profileDir, rel);
    if (fs.existsSync(file)) return { file, rel };
  }
  return null;
}

// Opera keeps cookies in the browser root itself; the others use per-profile
// subdirectories. Pick the profile whose cookie DB was written most recently.
function findProfile(root) {
  const own = cookieDbIn(root);
  const candidates = own ? [{ dir: root, ...own }] : [];

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name !== "Default" && !/^Profile \d+$/.test(name)) continue;
    const dir = path.join(root, name);
    const db = cookieDbIn(dir);
    if (db) candidates.push({ dir, ...db });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => statTimeOrZero(b.file) - statTimeOrZero(a.file));
  return candidates[0];
}

// Copy through a read+write pair rather than fs.copyFile: the former tolerates
// the share mode Chromium holds the SQLite file with, the latter does not.
async function copyLocked(src, dest) {
  try {
    const data = await fs.promises.readFile(src);
    await fs.promises.writeFile(dest, data);
  } catch (error) {
    await fs.promises.copyFile(src, dest);
  }
}

/**
 * Stage an unlocked copy of a Chromium profile and return the yt-dlp
 * `--cookies-from-browser` spec pointing at it. Returns null when this isn't
 * applicable (non-Windows, non-Chromium browser, browser not installed, ...),
 * in which case callers should fall back to the plain browser name.
 *
 * @returns {Promise<{spec: string, dir: string} | null>}
 */
async function stageChromiumProfile(browser) {
  if (process.platform !== "win32") return null;
  const root = browserRoot(browser);
  if (!root) return null;
  const profile = findProfile(root);
  if (!profile) return null;

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vf-cookies-"));
  // Mirror the layout yt-dlp expects: it derives the browser dir from the
  // profile's parent and searches it recursively for `Local State` (which
  // holds the DPAPI-wrapped key needed to decrypt cookie values).
  const userData = path.join(tmpRoot, "User Data");
  const profileDir = path.join(userData, "Default");
  await fs.promises.mkdir(path.dirname(path.join(profileDir, profile.rel)), { recursive: true });

  await copyLocked(profile.file, path.join(profileDir, profile.rel));
  // WAL/journal siblings carry recently written cookies; skip silently if absent.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const src = `${profile.file}${suffix}`;
    if (fs.existsSync(src)) {
      await copyLocked(src, `${path.join(profileDir, profile.rel)}${suffix}`).catch(() => {});
    }
  }

  const localState = path.join(root, "Local State");
  if (fs.existsSync(localState)) {
    await copyLocked(localState, path.join(userData, "Local State"));
  }

  return { spec: `${browser}:${profileDir}`, dir: tmpRoot };
}

function isChromiumBrowser(browser) {
  return Object.prototype.hasOwnProperty.call(BROWSER_DIRS, browser);
}

module.exports = { stageChromiumProfile, isChromiumBrowser };
