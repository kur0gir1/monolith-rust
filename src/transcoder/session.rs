use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::info;

use crate::error::AppError;
use crate::metadata::find_ffmpeg;
use crate::models::{HlsStreamInfo, TranscodeMode};
use crate::transcoder::nvenc::probe_nvenc_available;
use crate::transcoder::pipeline::build_ffmpeg_transcode_args;

pub struct ActiveSession {
    pub session_id: String,
    pub media_id: String,
    pub media_path: PathBuf,
    pub mode: TranscodeMode,
    pub temp_dir: PathBuf,
    pub active_audio_index: u32,
    pub child: Option<tokio::process::Child>,
    pub created_at: Instant,
    pub last_accessed: Instant,
}

impl Drop for ActiveSession {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
        let _ = fs::remove_dir_all(&self.temp_dir);
    }
}

#[derive(Clone, Default)]
pub struct SessionManager {
    sessions: Arc<RwLock<HashMap<String, ActiveSession>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Retrieves an active session's temp directory if available.
    pub async fn get_session_temp_dir(&self, media_id: &str) -> Option<PathBuf> {
        let mut map = self.sessions.write().await;
        if let Some(session) = map.get_mut(media_id) {
            session.last_accessed = Instant::now();
            Some(session.temp_dir.clone())
        } else {
            None
        }
    }

    /// Starts or resumes an HLS transcoding session for the given media item and audio index.
    pub async fn start_or_get_session(
        &self,
        media_id: &str,
        media_path: &Path,
        audio_index: u32,
    ) -> Result<HlsStreamInfo, AppError> {
        let mut map = self.sessions.write().await;

        if let Some(session) = map.get_mut(media_id) {
            session.last_accessed = Instant::now();
            if session.active_audio_index == audio_index {
                return Ok(HlsStreamInfo {
                    session_id: session.session_id.clone(),
                    master_playlist_url: format!("/api/stream/{}/master.m3u8", media_id),
                    variant_playlist_url: format!(
                        "/api/stream/{}/index.m3u8?audio={}",
                        media_id, audio_index
                    ),
                    mode: session.mode.clone(),
                    audio_index,
                });
            } else {
                info!(
                    "Audio track index changed from {} to {} for media {}. Re-mapping stream...",
                    session.active_audio_index, audio_index, media_id
                );
                // Stop current transcode child
                if let Some(mut child) = session.child.take() {
                    let _ = child.start_kill();
                }
            }
        }

        // Create dedicated temporary directory for this session
        let session_id = format!("monolith_{}_{}", media_id, audio_index);
        let temp_dir = std::env::temp_dir().join(&session_id);
        if temp_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
        }
        fs::create_dir_all(&temp_dir)?;

        let playlist_path = temp_dir.join("index.m3u8");
        let nvenc_available = probe_nvenc_available();
        let mode = if nvenc_available {
            TranscodeMode::NvencCuda
        } else {
            TranscodeMode::CpuLibx264
        };

        let ffmpeg = find_ffmpeg();
        let mut args = vec!["-y".to_string(), "-v".to_string(), "error".to_string()];
        args.extend(build_ffmpeg_transcode_args(
            &mode,
            media_path,
            &playlist_path,
            audio_index,
        ));

        info!(
            "Spawning FFmpeg transcoding session {} (mode: {:?}, audio: {})",
            session_id, mode, audio_index
        );

        let child = tokio::process::Command::new(&ffmpeg)
            .args(&args)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AppError::ProcessError(format!("Failed to spawn FFmpeg: {}", e)))?;

        let session = ActiveSession {
            session_id: session_id.clone(),
            media_id: media_id.to_string(),
            media_path: media_path.to_path_buf(),
            mode: mode.clone(),
            temp_dir,
            active_audio_index: audio_index,
            child: Some(child),
            created_at: Instant::now(),
            last_accessed: Instant::now(),
        };

        map.insert(media_id.to_string(), session);
        drop(map);

        // Wait up to 3 seconds for the variant playlist to begin writing without holding the write lock
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if playlist_path.exists() {
                if let Ok(meta) = fs::metadata(&playlist_path) {
                    if meta.len() > 0 {
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Ok(HlsStreamInfo {
            session_id,
            master_playlist_url: format!("/api/stream/{}/master.m3u8", media_id),
            variant_playlist_url: format!(
                "/api/stream/{}/index.m3u8?audio={}",
                media_id, audio_index
            ),
            mode,
            audio_index,
        })
    }

    /// Dynamically switches the active audio track for a media stream.
    pub async fn switch_audio_track(
        &self,
        media_id: &str,
        media_path: &Path,
        new_audio_index: u32,
    ) -> Result<(), AppError> {
        let _ = self
            .start_or_get_session(media_id, media_path, new_audio_index)
            .await?;
        Ok(())
    }

    /// Periodic reaper for idle transcoding sessions.
    pub async fn reap_idle_sessions(&self, max_idle: Duration) {
        let mut map = self.sessions.write().await;
        let mut expired = Vec::new();

        for (id, session) in map.iter() {
            if session.last_accessed.elapsed() > max_idle {
                expired.push(id.clone());
            }
        }

        for id in expired {
            if let Some(mut session) = map.remove(&id) {
                info!("Reaping expired transcode session for media {}", id);
                if let Some(mut child) = session.child.take() {
                    let _ = child.start_kill();
                }
                let _ = fs::remove_dir_all(&session.temp_dir);
            }
        }
    }
}
