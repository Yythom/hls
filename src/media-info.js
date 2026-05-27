const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function createMediaInfo({ ffmpegPath }) {
  const INFO_EXTS = [
    "mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "m4s",
    "3gp", "mpg", "mpeg", "wmv", "ogv", "gif", "apng",
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma",
  ];

  function probeRawInfo(filePath) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath(), ["-hide_banner", "-i", filePath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 200000) stderr = stderr.slice(-200000);
      });
      child.on("error", (error) => {
        if (error.code === "ENOENT") {
          reject(new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH."));
        } else {
          reject(error);
        }
      });
      child.on("close", () => resolve(stderr));
    });
  }

  function parseVideoStream(rest, item) {
    const codecMatch = rest.match(/^([A-Za-z0-9_]+)/);
    if (codecMatch) item.codec = codecMatch[1];
    const profile = rest.match(/^[A-Za-z0-9_]+\s*\(([^)]+)\)/);
    if (profile) item.profile = profile[1];
    const resMatch = rest.match(/(\b\d{2,5})x(\d{2,5})\b/);
    if (resMatch) {
      item.width = Number(resMatch[1]);
      item.height = Number(resMatch[2]);
    }
    const dar = rest.match(/DAR\s+([\d:]+)/);
    if (dar) item.dar = dar[1];
    const fpsMatch = rest.match(/([\d.]+)\s+fps/);
    if (fpsMatch) item.fps = Number(fpsMatch[1]);
    const brMatch = rest.match(/(\d+)\s*kb\/s/);
    if (brMatch) item.bitrate = Number(brMatch[1]);
    const pixMatch = rest.match(/,\s*(yuv\w+|gbrp\w*|gray\w*|rgba?\w*|bgra?\w*|nv\d+\w*|pal8)\b/);
    if (pixMatch) item.pixelFormat = pixMatch[1];
  }

  function parseAudioStream(rest, item) {
    const codecMatch = rest.match(/^([A-Za-z0-9_]+)/);
    if (codecMatch) item.codec = codecMatch[1];
    const profile = rest.match(/^[A-Za-z0-9_]+\s*\(([^)]+)\)/);
    if (profile) item.profile = profile[1];
    const hzMatch = rest.match(/(\d+)\s*Hz/);
    if (hzMatch) item.sampleRate = Number(hzMatch[1]);
    const chMatch = rest.match(/Hz,\s*([^,]+?)(?:,|$)/);
    if (chMatch) item.channels = chMatch[1].trim();
    const brMatch = rest.match(/(\d+)\s*kb\/s/);
    if (brMatch) item.bitrate = Number(brMatch[1]);
  }

  function parseMediaInfo(stderr) {
    const info = {
      format: "",
      durationText: "",
      duration: 0,
      bitrateText: "",
      bitrate: 0,
      start: "",
      metadata: {},
      videoStreams: [],
      audioStreams: [],
      otherStreams: [],
    };

    const inputMatch = stderr.match(/Input\s+#0,\s*([^\n]+?),\s*from\s+'/);
    if (inputMatch) info.format = inputMatch[1].trim();

    const durLine = stderr.match(/Duration:\s*([^\n]+)/);
    if (durLine) {
      const parts = durLine[1].split(",").map((p) => p.trim());
      for (const part of parts) {
        const dm = part.match(/^([\d:.]+|N\/A)$/);
        const sm = part.match(/^start:\s*(.+)$/);
        const bm = part.match(/^bitrate:\s*(.+)$/);
        if (dm && !info.durationText) info.durationText = dm[1];
        if (sm) info.start = sm[1];
        if (bm) info.bitrateText = bm[1];
      }
      const t = info.durationText.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) info.duration = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      const b = info.bitrateText.match(/(\d+)\s*kb\/s/);
      if (b) info.bitrate = Number(b[1]);
    }

    const inputIdx = stderr.indexOf("Input #0");
    const durIdx = inputIdx >= 0 ? stderr.indexOf("Duration:", inputIdx) : -1;
    if (inputIdx >= 0 && durIdx > inputIdx) {
      const block = stderr.slice(inputIdx, durIdx);
      const metaIdx = block.indexOf("Metadata:");
      if (metaIdx >= 0) {
        const lines = block.slice(metaIdx).split("\n").slice(1);
        for (const line of lines) {
          if (!line.trim()) continue;
          const m = line.match(/^\s+([^:]+?)\s*:\s*(.*)$/);
          if (!m) break;
          info.metadata[m[1].trim()] = m[2].trim();
        }
      }
    }

    const streamRegex = /Stream\s+#(\d+):(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?:\s+(Video|Audio|Subtitle|Data|Attachment):\s*([^\n]+)/g;
    let match;
    while ((match = streamRegex.exec(stderr))) {
      const [, , idx, lang, kind, rest] = match;
      const item = {
        index: Number(idx),
        language: lang || "",
        kind,
        raw: rest.trim(),
      };
      if (kind === "Video") {
        parseVideoStream(rest, item);
        info.videoStreams.push(item);
      } else if (kind === "Audio") {
        parseAudioStream(rest, item);
        info.audioStreams.push(item);
      } else {
        info.otherStreams.push(item);
      }
    }
    return info;
  }

  return { INFO_EXTS, probeRawInfo, parseMediaInfo };
}

module.exports = { createMediaInfo };
