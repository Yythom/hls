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
