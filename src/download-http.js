const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { isLikelyVideoResource, isMp4Item, delay } = require("./media");

function createHttpDownloader({ makeDownloadHeaders, remuxMp4File, send, logEvent }) {
  const DOWNLOAD_SEGMENT_SIZE = 4 * 1024 * 1024;
  const DOWNLOAD_MAX_PARALLEL = 4;
  const DOWNLOAD_MAX_RETRIES = 5;

  async function probeResource(item, baseHeaders) {
    try {
      const head = await fetch(item.url, {
        method: "HEAD",
        redirect: "follow",
        headers: baseHeaders,
      });
      if (head.ok) {
        const len = Number(head.headers.get("content-length")) || 0;
        const acceptRanges = (head.headers.get("accept-ranges") || "").toLowerCase();
        return {
          totalSize: len,
          acceptsRanges: acceptRanges.includes("bytes") && len > 0,
          contentType: head.headers.get("content-type") || "",
        };
      }
    } catch (error) {
      logEvent("debug", "HEAD probe failed, falling back to Range probe", {
        url: item.url,
        error: error.message,
      });
    }

    const probe = await fetch(item.url, {
      redirect: "follow",
      headers: { ...baseHeaders, Range: "bytes=0-0" },
    });
    if (probe.status === 206) {
      const cr = probe.headers.get("content-range") || "";
      const match = cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
      const total = match ? Number(match[1]) : 0;
      try {
        await probe.body?.cancel?.();
      } catch {
        /* ignore */
      }
      return {
        totalSize: total,
        acceptsRanges: total > 0,
        contentType: probe.headers.get("content-type") || "",
      };
    }
    if (!probe.ok) {
      throw new Error(`Download failed with HTTP ${probe.status}.`);
    }
    const len = Number(probe.headers.get("content-length")) || 0;
    try {
      await probe.body?.cancel?.();
    } catch {
      /* ignore */
    }
    return {
      totalSize: len,
      acceptsRanges: false,
      contentType: probe.headers.get("content-type") || "",
    };
  }

  async function downloadSegmentWithRetry(item, fd, seg, baseHeaders, onProgress) {
    for (let attempt = 0; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
      const rangeStart = seg.start + seg.downloaded;
      if (rangeStart > seg.end) return;

      try {
        const res = await fetch(item.url, {
          redirect: "follow",
          headers: { ...baseHeaders, Range: `bytes=${rangeStart}-${seg.end}` },
        });
        if (res.status !== 206) {
          throw new Error(`Range not honored, status ${res.status}`);
        }
        if (!res.body) throw new Error("No response body for range request");

        const reader = res.body.getReader();
        let writeOffset = rangeStart;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          await fd.write(value, 0, value.length, writeOffset);
          writeOffset += value.length;
          seg.downloaded += value.length;
          onProgress(value.length);
        }

        const expected = seg.end - seg.start + 1;
        if (seg.downloaded < expected) {
          throw new Error(`Segment incomplete: ${seg.downloaded}/${expected}`);
        }
        return;
      } catch (error) {
        if (attempt === DOWNLOAD_MAX_RETRIES) throw error;
        logEvent("warn", "Segment retrying", {
          url: item.url,
          segment: `${seg.start}-${seg.end}`,
          downloaded: seg.downloaded,
          attempt: attempt + 1,
          error: error.message,
        });
        await delay(400 * Math.pow(2, attempt));
      }
    }
  }

  async function downloadWithRanges(item, filePath, total, baseHeaders, onProgress) {
    const fd = await fs.promises.open(filePath, "w");
    try {
      await fd.truncate(total);

      const segments = [];
      for (let start = 0; start < total; start += DOWNLOAD_SEGMENT_SIZE) {
        const end = Math.min(start + DOWNLOAD_SEGMENT_SIZE - 1, total - 1);
        segments.push({ start, end, downloaded: 0 });
      }

      let receivedTotal = 0;
      let nextIndex = 0;
      const concurrency = Math.min(DOWNLOAD_MAX_PARALLEL, segments.length);

      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          const idx = nextIndex++;
          if (idx >= segments.length) return;
          await downloadSegmentWithRetry(item, fd, segments[idx], baseHeaders, (delta) => {
            receivedTotal += delta;
            onProgress(receivedTotal);
          });
        }
      });

      await Promise.all(workers);
      await fd.sync();
      return receivedTotal;
    } finally {
      await fd.close();
    }
  }

  async function downloadSingleStream(item, filePath, baseHeaders, onProgress) {
    let lastError;
    for (let attempt = 0; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(item.url, { redirect: "follow", headers: baseHeaders });
        if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}.`);

        const total = Number(res.headers.get("content-length")) || 0;
        const body = Readable.fromWeb(res.body);
        let received = 0;
        body.on("data", (chunk) => {
          received += chunk.length;
          onProgress(received, total);
        });

        await pipeline(body, fs.createWriteStream(filePath));

        if (total > 0 && received !== total) {
          throw new Error(`Truncated: received ${received}/${total} bytes`);
        }
        return { received, total };
      } catch (error) {
        lastError = error;
        if (attempt === DOWNLOAD_MAX_RETRIES) break;
        logEvent("warn", "Single-stream retry", {
          url: item.url,
          attempt: attempt + 1,
          error: error.message,
        });
        await delay(400 * Math.pow(2, attempt));
      }
    }
    throw lastError;
  }

  async function topUpFile(item, filePath, fromOffset, lastByte, baseHeaders) {
    const fd = await fs.promises.open(filePath, "r+");
    try {
      const seg = { start: fromOffset, end: lastByte, downloaded: 0 };
      await downloadSegmentWithRetry(item, fd, seg, baseHeaders, () => {});
      await fd.sync();
    } finally {
      await fd.close();
    }
  }

  async function downloadCandidate(item, filePath) {
    logEvent("info", "Starting HTTP download", {
      url: item.url,
      filePath,
      kind: item.kind,
    });

    const baseHeaders = await makeDownloadHeaders(item);
    const probe = await probeResource(item, baseHeaders);

    logEvent("info", "Probe result", {
      url: item.url,
      totalSize: probe.totalSize,
      acceptsRanges: probe.acceptsRanges,
      contentType: probe.contentType,
    });

    if (!isLikelyVideoResource(item.url, probe.contentType)) {
      throw new Error(
        `The server returned ${probe.contentType || "unknown content"} instead of a video. This is usually an auth, anti-hotlink, or expired URL response.`
      );
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    let total = probe.totalSize;
    let received = 0;

    try {
      if (probe.acceptsRanges && probe.totalSize > 0) {
        logEvent("info", "Downloading via parallel ranges", {
          totalSize: probe.totalSize,
          segments: Math.ceil(probe.totalSize / DOWNLOAD_SEGMENT_SIZE),
          parallel: DOWNLOAD_MAX_PARALLEL,
        });
        received = await downloadWithRanges(
          item,
          filePath,
          probe.totalSize,
          baseHeaders,
          (r) => {
            send("download:progress", { id: item.id, received: r, total, filePath });
          }
        );
      } else {
        logEvent("info", "Downloading via single stream (range not supported)");
        const result = await downloadSingleStream(item, filePath, baseHeaders, (r, t) => {
          if (t && !total) total = t;
          send("download:progress", { id: item.id, received: r, total, filePath });
        });
        received = result.received;
        if (result.total) total = result.total;
      }

      if (total > 0) {
        let stat = await fs.promises.stat(filePath);
        if (stat.size < total && probe.acceptsRanges) {
          logEvent("warn", "File short after download, topping up via range", {
            filePath,
            size: stat.size,
            expected: total,
          });
          await topUpFile(item, filePath, stat.size, total - 1, baseHeaders);
          stat = await fs.promises.stat(filePath);
        }
        if (stat.size !== total) {
          throw new Error(
            `Incomplete download: received ${stat.size} bytes, expected ${total} bytes. Please try again.`
          );
        }
        received = stat.size;
      }
    } catch (error) {
      await fs.promises.rm(filePath, { force: true });
      throw error;
    }

    logEvent("info", "HTTP download completed", { filePath, received, expected: total });

    try {
      const validation = await validateDownloadedFile(item, filePath, {
        expectedSize: total,
        actualSize: received,
        contentType: probe.contentType,
      });

      if (validation.canRemux) {
        send("download:status", { id: item.id, state: "repairing", filePath });
        logEvent("info", "Remuxing MP4", { filePath });
        await remuxMp4File(item, filePath);
        await validateDownloadedFile(item, filePath, {
          expectedSize: 0,
          actualSize: 0,
          contentType: probe.contentType,
        });
      }
    } catch (error) {
      logEvent("error", "Download validation or repair failed", {
        filePath,
        error: error.message,
      });
      await fs.promises.rm(filePath, { force: true });
      throw error;
    }

    logEvent("info", "Download ready", { filePath });
    return { id: item.id, filePath, received, total };
  }

  async function validateDownloadedFile(item, filePath, { expectedSize, actualSize, contentType }) {
    logEvent("debug", "Validating downloaded file", {
      filePath,
      expectedSize,
      actualSize,
      contentType,
    });

    if (expectedSize > 0 && actualSize !== expectedSize) {
      throw new Error(
        `Incomplete download: received ${actualSize} bytes, expected ${expectedSize} bytes. Please try again.`
      );
    }

    if (!isMp4Item(item, contentType)) return { canRemux: false };

    const handle = await fs.promises.open(filePath, "r");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const hasFtyp = bytesRead >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp";
      if (!hasFtyp) {
        logEvent("warn", "Downloaded file does not look like a standard MP4", {
          filePath,
          note: "The file was kept, but common players may not open it.",
        });
        return { canRemux: false };
      }
      logEvent("debug", "MP4 header validated", { filePath });
      return { canRemux: true };
    } finally {
      await handle.close();
    }
  }

  return { downloadCandidate };
}

module.exports = { createHttpDownloader };
