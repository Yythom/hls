// Task kinds the global queue can run. Each handler provides:
//   lane                      which concurrency lane it runs in
//   describe(job)             validate the job; { title, output } for display and
//                             for detecting two tasks writing the same file
//   run(job, ctx)             do the work; resolves to { filePath, size, summary? }
//   mapProgress(channel, p)   turn a worker module's progress event into
//                             { phase, percent, text } for the queue (optional)

const fs = require("fs");
const path = require("path");
const { isStreamItem } = require("./media");
const { removeByToken } = require("./task-journal");

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function percentOf(done, total) {
  return total > 0 ? Math.min(100, (done / total) * 100) : null;
}

// ffmpeg `-progress` based encodes: elapsed / total seconds of output.
function encodingProgress(p, label = "处理中") {
  const percent = percentOf(p.elapsed, p.total);
  return {
    phase: "encoding",
    percent,
    text:
      percent === null
        ? `${label} ${formatClock(p.elapsed)}`
        : `${label} ${formatClock(p.elapsed)} / ${formatClock(p.total)}（${percent.toFixed(0)}%）`,
  };
}

async function statOutput(filePath) {
  const stat = await fs.promises.stat(filePath);
  return { filePath, size: stat.size };
}

// Run `work(partialPath)` against a task-tagged scratch name next to `output`
// (`name.vfpart-<task>.mp4`) and only rename it into place once it succeeded.
// A crash therefore never leaves a truncated file under the real name, and
// every scratch file the worker derives from that name (`.hls-tmp`,
// `.trim-tmp`, remux temps) shares the token, so one sweep finds them all.
async function withPartialOutput(ctx, output, work) {
  const dir = path.dirname(output);
  const { name, ext } = path.parse(output);
  const token = `vfpart-${ctx.id.replace(/^task-/, "")}`;
  const partial = path.join(dir, `${name}.${token}${ext}`);
  ctx.track({ marker: token, token, dir });
  try {
    const result = await work(partial);
    await fs.promises.rename(partial, output);
    return { ...result, ...(await statOutput(output)) };
  } finally {
    await removeByToken(dir, token);
  }
}

function requireOutput(job) {
  if (!job.output) throw new Error("缺少输出路径");
  return job.output;
}

const TOOL_LABELS = {
  audio: "提取音频",
  convert: "格式转换",
  compress: "视频压缩",
  image: "图片处理",
  watermark: "水印",
  gif: "转 GIF",
  concat: "视频拼接",
};

function createTaskHandlers({ ytdlp, httpDownloader, hlsDownloader, tools, tmpRoot, logEvent }) {
  // Per-task scratch dir for yt-dlp's `.part` / fragment files. Kept after a
  // cancel or failure so a retry resumes; removed once the task is done or
  // dropped from the list, and wholesale on quit.
  const ytdlpTempDir = (taskId) => path.join(tmpRoot, taskId);

  // yt-dlp: online video sites.
  const ytdlpHandler = {
    lane: "network",
    describe(job) {
      if (!job.url) throw new Error("缺少视频链接");
      if (!job.output && !job.outputDir) throw new Error("缺少保存位置");
      return { title: job.title || job.url, output: job.output || "" };
    },
    async run(job, ctx) {
      const tempDir = ytdlpTempDir(ctx.id);
      await fs.promises.mkdir(tempDir, { recursive: true });
      ctx.track({ marker: tempDir, path: tempDir });
      const result = await ytdlp.runDownload({ ...job, tempDir }, {
        onProgress: (p) => {
          if (p.phase === "merging") ctx.update({ phase: "merging", text: "合并音视频…" });
          else if (p.phase === "post-processing") ctx.update({ phase: "post", text: "后处理中…" });
          else if (p.phase === "downloading") {
            const bits = [`下载 ${Number(p.percent || 0).toFixed(1)}%`];
            if (p.total) bits.push(p.total);
            if (p.speed) bits.push(p.speed);
            if (p.eta) bits.push(`剩余 ${p.eta}`);
            ctx.update({ phase: "downloading", percent: p.percent, text: bits.join(" · ") });
          }
        },
      });
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      return result;
    },
    cleanup(taskId) {
      return fs.promises.rm(ytdlpTempDir(taskId), { recursive: true, force: true });
    },
    cleanupAll() {
      return fs.promises.rm(tmpRoot, { recursive: true, force: true });
    },
  };

  // Resources found by the page scanner: direct files, HLS, DASH.
  const downloadHandler = {
    lane: "network",
    describe(job) {
      if (!job.item?.url) throw new Error("缺少下载资源");
      const output = requireOutput(job);
      return { title: path.basename(output), output };
    },
    run({ item, output }, ctx) {
      logEvent("info", "Download started", { url: item.url, filePath: output, kind: item.kind });
      return withPartialOutput(ctx, output, async (partial) => {
        if (isStreamItem(item)) await hlsDownloader.downloadStreamCandidate(item, partial);
        else await httpDownloader.downloadCandidate(item, partial);
      });
    },
    mapProgress(channel, p) {
      if (channel === "download:status") {
        if (p.state === "repairing") return { phase: "repair", text: "修复 MP4…" };
        if (p.state === "verifying") return { phase: "verify", text: "校验视频…" };
        return null;
      }
      if (channel !== "download:progress") return null;
      switch (p.mode) {
        case "hls-segments":
          return {
            phase: "segments",
            percent: percentOf(p.received, p.total),
            text: `分片 ${p.received} / ${p.total}${p.bytes ? ` · ${formatBytes(p.bytes)}` : ""}`,
          };
        case "hls-merging":
          return { phase: "merging", text: "合并分片…" };
        case "stream":
          return { phase: "stream", text: "下载流中…" };
        case "remux":
          return { phase: "repair", text: "修复 MP4…" };
        case "reencode":
          return { phase: "reencode", text: "重新编码（流参数中途变化）…" };
        case "verify":
          return { phase: "verify", text: "校验视频…" };
        default: {
          const percent = percentOf(p.received, p.total);
          return {
            phase: "downloading",
            percent,
            text:
              percent === null
                ? `已下载 ${formatBytes(p.received)}`
                : `${percent.toFixed(0)}% · ${formatBytes(p.received)} / ${formatBytes(p.total)}`,
          };
        }
      }
    },
  };

  // ffmpeg tools: audio / convert / compress / image / watermark / gif / concat.
  const toolHandler = {
    lane: "cpu",
    describe(job) {
      const label = TOOL_LABELS[job.op];
      if (!label) throw new Error(`不支持的操作：${job.op}`);
      const output = requireOutput(job);
      if (job.op === "concat") {
        if (!Array.isArray(job.inputs) || job.inputs.length < 2) throw new Error("至少需要两个视频");
        return { title: `${label} · ${job.inputs.length} 个文件`, output };
      }
      if (!job.input) throw new Error("缺少源文件");
      return { title: `${label} · ${path.basename(job.input)}`, output };
    },
    async run({ op, input, inputs, output: finalOutput, options }, ctx) {
      const item = { id: ctx.id };
      logEvent("info", "Tool starting", { op, output: finalOutput, options });
      const result = await withPartialOutput(ctx, finalOutput, async (output) => {
        let totalDuration = 0;
        if (op !== "concat" && op !== "gif" && op !== "image") {
          try {
            totalDuration = await tools.probeDuration(input);
          } catch {
            /* probe is best-effort */
          }
        }
        if (op === "audio") await tools.runExtractAudio(input, output, options, item, totalDuration);
        else if (op === "convert") await tools.runConvert(input, output, options, item, totalDuration);
        else if (op === "compress") await tools.runCompress(input, output, options, item, totalDuration);
        else if (op === "image") await tools.runImage(input, output, options, item);
        else if (op === "watermark") await tools.runWatermark(input, output, options, item, totalDuration);
        else if (op === "gif") await tools.runGif(input, output, options, item);
        else if (op === "concat") await tools.runConcat(inputs, output, options, item);
      });
      logEvent("info", "Tool completed", { op, output: finalOutput, size: result.size });
      return result;
    },
    mapProgress(channel, p) {
      if (channel !== "tools:progress") return null;
      if (p.phase === "concatenating") return { phase: "concat", percent: 92, text: "合并中…" };
      if (p.phase === "image") return { phase: "image", percent: p.percent || 35, text: p.message || "处理中" };
      if (p.phase === "encoding") return encodingProgress(p);
      return null;
    },
  };

  // Delete ranges from a video.
  const trimHandler = {
    lane: "cpu",
    describe(job) {
      if (!job.input) throw new Error("缺少源视频");
      if (!Array.isArray(job.ranges) || job.ranges.length === 0) throw new Error("至少需要一个删除区间");
      const output = requireOutput(job);
      return { title: `视频裁剪 · ${path.basename(job.input)}`, output };
    },
    async run({ input, output, ranges, mode, duration }, ctx) {
      const totalDuration = Number(duration) > 0 ? Number(duration) : await tools.probeDuration(input);
      const deleteRanges = tools.normalizeDeleteRanges(ranges, totalDuration);
      if (deleteRanges.length === 0) throw new Error("没有有效的删除区间");
      const keepRanges = tools.computeKeepRanges(deleteRanges, totalDuration);
      if (keepRanges.length === 0) throw new Error("删除区间覆盖了整个视频，没有可保留的内容");
      const totalKept = keepRanges.reduce((acc, [a, b]) => acc + (b - a), 0);
      const range = ([a, b]) => `${tools.formatTimecode(a)}-${tools.formatTimecode(b)}`;
      logEvent("info", "Trim starting", {
        input,
        output,
        mode,
        totalDuration,
        totalKept,
        deleteRanges: deleteRanges.map(range),
        keepRanges: keepRanges.map(range),
      });
      const item = { id: ctx.id };
      const result = await withPartialOutput(ctx, output, async (partial) => {
        if (mode === "fast") await tools.runTrimFast(input, partial, keepRanges, item);
        else await tools.runTrimAccurate(input, partial, deleteRanges, totalKept, item);
        const { size } = await fs.promises.stat(partial);
        if (size < 1024) throw new Error(`输出文件过小（${size} 字节）`);
      });
      return { ...result, summary: `保留 ${totalKept.toFixed(2)} 秒` };
    },
    mapProgress(channel, p) {
      if (channel !== "trim:progress") return null;
      if (p.phase === "encoding") return encodingProgress(p, "编码中");
      if (p.phase === "extracting") {
        return {
          phase: `extract-${p.segmentIndex}`,
          percent: percentOf(p.segmentIndex + 1, p.totalSegments),
          text: `提取片段 ${p.segmentIndex + 1} / ${p.totalSegments}`,
        };
      }
      if (p.phase === "concatenating") return { phase: "concat", percent: 95, text: "合并片段…" };
      return null;
    },
  };

  return { ytdlp: ytdlpHandler, download: downloadHandler, tool: toolHandler, trim: trimHandler };
}

// Channels worker modules use for progress; inside a task they are routed to
// that task instead of being broadcast to the renderer.
const TASK_PROGRESS_CHANNELS = new Set(["download:progress", "download:status", "tools:progress", "trim:progress"]);

module.exports = { createTaskHandlers, TASK_PROGRESS_CHANNELS };
