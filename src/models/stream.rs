use std::path::PathBuf;
use std::time::Instant;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscodeMode {
    NvencCuda,
    CpuLibx264,
    DirectStream,
}

#[derive(Debug)]
pub struct TranscodeSession {
    pub session_id: String,
    pub media_id: String,
    pub mode: TranscodeMode,
    pub temp_dir: PathBuf,
    pub active_audio_index: u32,
    pub created_at: Instant,
    pub last_accessed: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HlsStreamInfo {
    pub session_id: String,
    pub master_playlist_url: String,
    pub variant_playlist_url: String,
    pub mode: TranscodeMode,
    pub audio_index: u32,
}
