use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: String,                 // File hash or deterministic UUID
    pub file_path: String,          // Absolute file path
    pub file_name: String,          // File name with extension
    pub file_size_bytes: u64,       // File size in bytes
    pub extension: String,          // Normalized extension: mkv, mp4, webm, avi
    pub metadata: Option<MediaMetadata>,
    pub poster_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub video_codec: String,
    pub bitrate_kbps: Option<u64>,
    pub audio_tracks: Vec<AudioTrack>,
    pub subtitle_tracks: Vec<SubtitleTrack>,
}

impl MediaMetadata {
    pub fn resolution(&self) -> Resolution {
        Resolution::new(self.width, self.height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Resolution {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    pub fn aspect_ratio(&self) -> f64 {
        if self.height == 0 {
            0.0
        } else {
            self.width as f64 / self.height as f64
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioTrack {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub channel_layout: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub index: u32,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub is_default: bool,
    pub is_forced: bool,
    pub is_bitmap: bool,
}
