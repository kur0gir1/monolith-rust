# MONOLITH // OFFLINE MEDIA ENGINE

Monolith is a local-first, zero-API offline media streaming desktop application and LAN server built with **Rust (Tauri v2 + Axum)**, **React 19 (TypeScript + Vite)**, and **FFmpeg**.

It indexes local video libraries strictly offline using `ffprobe`, extracts and caches cover art by SHA-256 file hash, and streams real-time HLS video over your local network with **NVIDIA NVENC CUDA** hardware acceleration (and automatic **CPU `libx264`** fallback), dynamic audio track switching, and on-the-fly **WebVTT** subtitle extraction—wrapped in a stark monochrome Brutalist UI.

---

## Features

- **100% Offline & Local-First**: Zero external API calls (no TMDB/IMDB scraping or telemetry).
- **Recursive Library Scanner**: Multi-threaded directory walker for `.mkv`, `.mp4`, `.webm`, and `.avi` with Windows long-path (`\\?\`) support and symlink cycle protection.
- **FFprobe Metadata & SHA-256 Poster Cache**: Extracts resolution, duration, codecs, audio tracks, and subtitle streams via `ffprobe`; extracts embedded artwork (with video frame fallback) to `%LOCALAPPDATA%\Monolith\cache\posters\<sha256>.jpg`.
- **Hardware-Accelerated HLS Transcoding**:
  - Primary: NVIDIA NVENC (`-hwaccel cuda -hwaccel_output_format cuda -c:v h264_nvenc -preset p4 -b:v 5M`)
  - Fallback: Automatic detection and fallback to CPU (`-c:v libx264 -preset veryfast -b:v 5M`)
  - Serves `.m3u8` master/variant playlists and 2-second `.ts` segments over `0.0.0.0:9000`.
- **Live Audio & Subtitle Track Routing**:
  - Switch multi-language audio streams on the fly (`-map 0:v:0 -map 0:a:<index>`).
  - Real-time embedded subtitle conversion to browser-ready WebVTT (`subs.vtt`).
- **Brutalist Monochrome UI**: High-contrast `#000000` / `#FFFFFF` layout, exposed 2px grid borders, monospaced typography, and global SVG `feTurbulence` noise overlay.

---

## Prerequisites

- **Windows 10/11** (with WebView2)
- **Rust** (`stable-x86_64-pc-windows-msvc`)
- **Node.js** (v20+) & **npm** / **pnpm**
- **FFmpeg & FFprobe** on `PATH`:
  ```powershell
  winget install --id Gyan.FFmpeg -e
  ```

---

## Building & Running

### 1. Build the Frontend SPA
```powershell
cd frontend
npm install
npm run build
cd ..
```

### 2. Build the Release Executable (`.exe`)
```powershell
cargo build --release
```
The compiled standalone executable will be generated at:
```text
target/release/monolith.exe
```

### 3. Run in Development Mode
```powershell
cargo run
```
Once launched:
- **Desktop Host**: Opens the native Monolith window (`MONOLITH // OFFLINE STREAMING`).
- **LAN Web Access**: Any device on your local network can browse and stream from `http://<YOUR_LAN_IP>:9000`.

---

## License

This project is licensed under the [MIT License](LICENSE).
