# Video Finder

Desktop app for discovering and downloading video resources from web pages.

## Run

```bash
npm install
npm start
```

## What it detects

- Direct media files such as MP4, WebM, M4V, MOV, MKV, AVI, and FLV.
- HLS manifests (`.m3u8`).
- DASH manifests (`.mpd`).
- Media URLs referenced by video/source tags, links, performance entries, and network responses.

HLS and DASH entries are downloaded through `ffmpeg` and saved as MP4 files. If `ffmpeg` is not on `PATH`, set `FFMPEG_PATH=/path/to/ffmpeg` before starting the app.

## Online video sites (B站 / YouTube / 抖音 / Twitter / etc.)

The "在线视频" tab uses [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) to resolve and download videos from sites that need extraction. Packaged builds bundle the yt-dlp binary (fetched via `npm run fetch:ytdlp` during `predist`), so end users don't need to install anything.

For local development, fetch the binary once:

```bash
npm run fetch:ytdlp     # downloads into resources/yt-dlp/<platform-arch>/
```

To override the bundled binary (e.g. to use a newer yt-dlp), set `YT_DLP_PATH=/path/to/yt-dlp` before starting the app. To pin a specific release at fetch time, set `YT_DLP_TAG=2025.10.22` (defaults to `latest`).
