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
        video_codec: Option<&str>,
    ) -> Result<HlsStreamInfo, AppError> {
        let mut map = self.sessions.write().await;

        if let Some(session) = map.get_mut(media_id) {
            session.last_accessed = Instant::now();
            let playlist_check = session.temp_dir.join("index.m3u8");
            if session.active_audio_index == audio_index && playlist_check.exists() {
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
                    "Restarting or re-mapping stream for media {} (audio {})...",
                    media_id, audio_index
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
        let is_h264 = video_codec
            .map(|c| c.eq_ignore_ascii_case("h264") || c.eq_ignore_ascii_case("avc1"))
            .unwrap_or(false);
        let nvenc_available = probe_nvenc_available();

        let mut candidate_modes = Vec::new();
        if is_h264 {
            candidate_modes.push(TranscodeMode::DirectStream);
        }
        if nvenc_available {
            candidate_modes.push(TranscodeMode::NvencCuda);
        }
        candidate_modes.push(TranscodeMode::CpuLibx264);

        let ffmpeg = find_ffmpeg();
        let mut active_mode = TranscodeMode::CpuLibx264;
        let mut spawned_child: Option<tokio::process::Child> = None;

        for mode in candidate_modes {
            let _ = fs::remove_file(&playlist_path);
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

            let mut cmd = tokio::process::Command::new(&ffmpeg);
            cmd.args(&args).kill_on_drop(true);
            #[cfg(windows)]
            {
                cmd.creation_flags(crate::metadata::CREATE_NO_WINDOW);
            }

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Poll until playlist has at least one .ts segment OR child exits early with error
            let start = Instant::now();
            let mut ready = false;
            let mut exited_early = false;
            while start.elapsed() < Duration::from_secs(10) {
                if playlist_path.exists() {
                    if let Ok(content) = fs::read_to_string(&playlist_path) {
                        if content.contains(".ts") {
                            ready = true;
                            break;
                        }
                    }
                }
                if let Ok(Some(status)) = child.try_wait() {
                    if !status.success() {
                        exited_early = true;
                        break;
                    }
                    // Even if status.success() on very short clips, check playlist one more time
                    if playlist_path.exists() {
                        ready = true;
                    }
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }

            if ready || !exited_early {
                active_mode = mode;
                spawned_child = Some(child);
                break;
            } else {
                let _ = child.start_kill();
                info!(
                    "FFmpeg mode {:?} exited early on {}, falling back to next transcode mode...",
                    mode,
                    media_path.display()
                );
            }
        }

        let session = ActiveSession {
            session_id: session_id.clone(),
            media_id: media_id.to_string(),
            media_path: media_path.to_path_buf(),
            mode: active_mode.clone(),
            temp_dir,
            active_audio_index: audio_index,
            child: spawned_child,
            created_at: Instant::now(),
            last_accessed: Instant::now(),
        };

        map.insert(media_id.to_string(), session);
        drop(map);

        Ok(HlsStreamInfo {
            session_id,
            master_playlist_url: format!("/api/stream/{}/master.m3u8", media_id),
            variant_playlist_url: format!(
                "/api/stream/{}/index.m3u8?audio={}",
                media_id, audio_index
            ),
            mode: active_mode,
            audio_index,
        })
    }

    /// Dynamically switches the active audio track for a media stream.
    pub async fn switch_audio_track(
        &self,
        media_id: &str,
        media_path: &Path,
        new_audio_index: u32,
        video_codec: Option<&str>,
    ) -> Result<(), AppError> {
        let _ = self
            .start_or_get_session(media_id, media_path, new_audio_index, video_codec)
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
