use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use tracing::debug;

use crate::error::AppError;
use crate::models::{AudioTrack, MediaMetadata, SubtitleTrack};

/// Windows CREATE_NO_WINDOW process creation flag (`0x08000000`) to prevent console windows from flashing.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Extension helper to suppress flashing console windows on Windows for `std::process::Command`.
pub trait NoWindowCommandExt {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindowCommandExt for Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

static FFPROBE_BIN_CACHE: OnceLock<PathBuf> = OnceLock::new();
static FFMPEG_BIN_CACHE: OnceLock<PathBuf> = OnceLock::new();

/// Locates the `ffprobe` executable on the host system (cached after first lookup).
pub fn find_ffprobe() -> PathBuf {
    FFPROBE_BIN_CACHE
        .get_or_init(|| {
            if let Ok(path) = std::env::var("FFPROBE_PATH") {
                let p = PathBuf::from(path);
                if p.exists() {
                    return p;
                }
            }

            #[cfg(windows)]
            {
                if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                    let winget_path = PathBuf::from(local_app_data)
                        .join("Microsoft")
                        .join("WinGet")
                        .join("Links")
                        .join("ffprobe.exe");
                    if winget_path.exists() {
                        return winget_path;
                    }
                }

                if let Ok(output) = Command::new("where.exe")
                    .arg("ffprobe")
                    .no_window()
                    .output()
                {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        if let Some(first_line) = stdout.lines().next() {
                            let p = PathBuf::from(first_line.trim());
                            if p.exists() {
                                return p;
                            }
                        }
                    }
                }
            }

            #[cfg(not(windows))]
            {
                if let Ok(output) = Command::new("which").arg("ffprobe").output() {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        if let Some(first_line) = stdout.lines().next() {
                            let p = PathBuf::from(first_line.trim());
                            if p.exists() {
                                return p;
                            }
                        }
                    }
                }
            }

            PathBuf::from("ffprobe")
        })
        .clone()
}

/// Locates the `ffmpeg` executable on the host system (cached after first lookup).
pub fn find_ffmpeg() -> PathBuf {
    FFMPEG_BIN_CACHE
        .get_or_init(|| {
            if let Ok(path) = std::env::var("FFMPEG_PATH") {
                let p = PathBuf::from(path);
                if p.exists() {
                    return p;
                }
            }

            #[cfg(windows)]
            {
                if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                    let winget_path = PathBuf::from(local_app_data)
                        .join("Microsoft")
                        .join("WinGet")
                        .join("Links")
                        .join("ffmpeg.exe");
                    if winget_path.exists() {
                        return winget_path;
                    }
                }

                if let Ok(output) = Command::new("where.exe")
                    .arg("ffmpeg")
                    .no_window()
                    .output()
                {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        if let Some(first_line) = stdout.lines().next() {
                            let p = PathBuf::from(first_line.trim());
                            if p.exists() {
                                return p;
                            }
                        }
                    }
                }
            }

            #[cfg(not(windows))]
            {
                if let Ok(output) = Command::new("which").arg("ffmpeg").output() {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        if let Some(first_line) = stdout.lines().next() {
                            let p = PathBuf::from(first_line.trim());
                            if p.exists() {
                                return p;
                            }
                        }
                    }
                }
            }

            PathBuf::from("ffmpeg")
        })
        .clone()
}

/// Strictly offline media metadata probe using ffprobe JSON inspection.
/// Zero external API calls.
pub fn probe_media_file(file_path: &Path) -> Result<MediaMetadata, AppError> {
    if !file_path.exists() {
        return Err(AppError::NotFound(format!(
            "Media file not found: {}",
            file_path.display()
        )));
    }

    let ffprobe_bin = find_ffprobe();
    debug!("Running ffprobe via {:?} on {}", ffprobe_bin, file_path.display());

    let output = Command::new(&ffprobe_bin)
        .no_window()
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            file_path.to_str().ok_or_else(|| {
                AppError::InvalidPath(format!("Path contains invalid UTF-8: {}", file_path.display()))
            })?,
        ])
        .output()
        .map_err(|e| AppError::ProcessError(format!("Failed to spawn ffprobe: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::ProcessError(format!(
            "ffprobe exited with status {}: {}",
            output.status, stderr
        )));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;

    parse_metadata_json(&json)
}

/// Parse ffprobe JSON output into strongly typed MediaMetadata domain struct.
pub fn parse_metadata_json(json: &serde_json::Value) -> Result<MediaMetadata, AppError> {
    let format = json
        .get("format")
        .ok_or_else(|| AppError::ProcessError("Missing 'format' section in ffprobe output".to_string()))?;

    let duration_seconds = format
        .get("duration")
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let bitrate_kbps = format
        .get("bit_rate")
        .and_then(|b| b.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|bps| bps / 1000);

    let streams = json
        .get("streams")
        .and_then(|s| s.as_array())
        .ok_or_else(|| AppError::ProcessError("Missing 'streams' array in ffprobe output".to_string()))?;

    let mut video_width = 0;
    let mut video_height = 0;
    let mut video_codec = String::new();
    let mut audio_tracks = Vec::new();
    let mut subtitle_tracks = Vec::new();

    for stream in streams {
        let codec_type = stream
            .get("codec_type")
            .and_then(|c| c.as_str())
            .unwrap_or("");

        let disposition = stream.get("disposition");
        let is_attached_pic = disposition
            .and_then(|d| d.get("attached_pic"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            == 1;

        match codec_type {
            "video" if !is_attached_pic => {
                if video_width == 0 {
                    video_width = stream.get("width").and_then(|w| w.as_u64()).unwrap_or(0) as u32;
                    video_height = stream.get("height").and_then(|h| h.as_u64()).unwrap_or(0) as u32;
                    video_codec = stream
                        .get("codec_name")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
            "audio" => {
                // Use 0-based audio-relative stream index so `0:a:{index}` in FFmpeg maps accurately
                let index = audio_tracks.len() as u32;
                let codec = stream
                    .get("codec_name")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let channels = stream.get("channels").and_then(|c| c.as_u64()).unwrap_or(0) as u32;
                let channel_layout = stream
                    .get("channel_layout")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());
                let tags = stream.get("tags");
                let language = tags
                    .and_then(|t| t.get("language"))
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string());
                let title = tags
                    .and_then(|t| t.get("title"))
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string());

                audio_tracks.push(AudioTrack {
                    index,
                    codec,
                    channels,
                    channel_layout,
                    language,
                    title,
                });
            }
            "subtitle" => {
                let index = stream.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
                let codec = stream
                    .get("codec_name")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let tags = stream.get("tags");
                let language = tags
                    .and_then(|t| t.get("language"))
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string());
                let title = tags
                    .and_then(|t| t.get("title"))
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string());

                let is_default = disposition
                    .and_then(|d| d.get("default"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    == 1;
                let is_forced = disposition
                    .and_then(|d| d.get("forced"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    == 1;
                let is_bitmap = ["dvd_subtitle", "hdmv_pgs_subtitle", "vobsub", "pgssub"]
                    .contains(&codec.as_str());

                subtitle_tracks.push(SubtitleTrack {
                    index,
                    codec,
                    language,
                    title,
                    is_default,
                    is_forced,
                    is_bitmap,
                });
            }
            _ => {}
        }
    }

    Ok(MediaMetadata {
        duration_seconds,
        width: video_width,
        height: video_height,
        video_codec,
        bitrate_kbps,
        audio_tracks,
        subtitle_tracks,
    })
}
