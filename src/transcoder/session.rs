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
use crate::transcoder::pipeline::build_ffmpeg_transcode_args_from;

const MAX_CONCURRENT_SESSIONS: usize = 2;

#[cfg(windows)]
mod win_job {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInfo {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInfo {
        basic: BasicLimitInfo,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, info_class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    }

    struct JobHandle(*mut c_void);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

    /// Attaches child processes to a Job Object so the OS kills all ffmpeg processes on app exit/crash.
    pub fn assign_child(child: &tokio::process::Child) {
        let Some(job) = JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info = ExtendedLimitInfo::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&info as *const ExtendedLimitInfo).cast(),
                std::mem::size_of::<ExtendedLimitInfo>() as u32,
            );
            if ok == 0 {
                return None;
            }
            Some(JobHandle(h))
        }) else {
            return;
        };

        if let Some(raw_proc) = child.raw_handle() {
            unsafe {
                let _ = AssignProcessToJobObject(job.0, raw_proc.cast());
            }
        }
    }
}

pub struct ActiveSession {
    pub session_id: String,
    pub media_id: String,
    pub media_path: PathBuf,
    pub mode: TranscodeMode,
    pub temp_dir: PathBuf,
    pub active_audio_index: u32,
    pub start_seconds: u64,
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

    fn session_key(media_id: &str, audio_index: u32, start_seconds: u64) -> String {
        format!("{}_{}_{}", media_id, audio_index, start_seconds)
    }

    /// Retrieves the most recently accessed active session's temp directory for `media_id`.
    pub async fn get_session_temp_dir(&self, media_id: &str) -> Option<PathBuf> {
        let mut map = self.sessions.write().await;
        let best_key = map
            .iter()
            .filter(|(_, s)| s.media_id == media_id)
            .max_by_key(|(_, s)| s.last_accessed)
            .map(|(k, _)| k.clone())?;
        if let Some(session) = map.get_mut(&best_key) {
            session.last_accessed = Instant::now();
            Some(session.temp_dir.clone())
        } else {
            None
        }
    }

    /// Retrieves an exact session's temp directory for `(media_id, audio_index, start_seconds)`.
    pub async fn get_session_temp_dir_at(
        &self,
        media_id: &str,
        audio_index: u32,
        start_seconds: u64,
    ) -> Option<PathBuf> {
        let key = Self::session_key(media_id, audio_index, start_seconds);
        let mut map = self.sessions.write().await;
        if let Some(session) = map.get_mut(&key) {
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
        self.start_or_get_session_at(media_id, media_path, audio_index, video_codec, 0)
            .await
    }

    /// Starts or resumes an HLS transcoding session starting at `start_seconds`.
    pub async fn start_or_get_session_at(
        &self,
        media_id: &str,
        media_path: &Path,
        audio_index: u32,
        video_codec: Option<&str>,
        start_seconds: u64,
    ) -> Result<HlsStreamInfo, AppError> {
        let key = Self::session_key(media_id, audio_index, start_seconds);
        let mut map = self.sessions.write().await;

        if let Some(session) = map.get_mut(&key) {
            session.last_accessed = Instant::now();
            let playlist_check = session.temp_dir.join("index.m3u8");
            let child_alive = match session.child.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(None)),
                None => false,
            };
            let is_complete = playlist_check.exists()
                && fs::read_to_string(&playlist_check)
                    .map(|c| c.contains("#EXT-X-ENDLIST"))
                    .unwrap_or(false);
            if playlist_check.exists() && (child_alive || is_complete) {
                return Ok(HlsStreamInfo {
                    session_id: session.session_id.clone(),
                    master_playlist_url: format!("/api/stream/{}/master.m3u8", media_id),
                    variant_playlist_url: format!(
                        "/api/stream/{}/s/{}/{}/index.m3u8",
                        media_id, audio_index, start_seconds
                    ),
                    mode: session.mode.clone(),
                    audio_index,
                });
            }
            if let Some(mut child) = session.child.take() {
                let _ = child.start_kill();
            }
        }

        // Globally cap concurrent active FFmpeg sessions so GPU VRAM and decoders are never starved
        while map.len() >= MAX_CONCURRENT_SESSIONS {
            if let Some(oldest_key) = map
                .iter()
                .filter(|(k, _)| *k != &key)
                .min_by_key(|(_, s)| s.last_accessed)
                .map(|(k, _)| k.clone())
            {
                if let Some(mut old) = map.remove(&oldest_key) {
                    if let Some(mut child) = old.child.take() {
                        let _ = child.start_kill();
                    }
                    let _ = fs::remove_dir_all(&old.temp_dir);
                }
            } else {
                break;
            }
        }

        // Create dedicated temporary directory for this session
        let session_id = format!("monolith_{}", key);
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
            args.extend(build_ffmpeg_transcode_args_from(
                &mode,
                media_path,
                &playlist_path,
                audio_index,
                start_seconds,
            ));

            info!(
                "Spawning FFmpeg transcoding session {} (mode: {:?}, audio: {}, start: {}s)",
                session_id, mode, audio_index, start_seconds
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
            #[cfg(windows)]
            win_job::assign_child(&child);

            // Poll until playlist has at least one .ts segment OR child exits early with error
            let start = Instant::now();
            let mut ready = false;
            let mut exited_early = false;
            while start.elapsed() < Duration::from_secs(25) {
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
            start_seconds,
            child: spawned_child,
            created_at: Instant::now(),
            last_accessed: Instant::now(),
        };

        map.insert(key, session);
        drop(map);

        Ok(HlsStreamInfo {
            session_id,
            master_playlist_url: format!("/api/stream/{}/master.m3u8", media_id),
            variant_playlist_url: format!(
                "/api/stream/{}/s/{}/{}/index.m3u8",
                media_id, audio_index, start_seconds
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

    /// Terminates every active transcoding session immediately (e.g. during application exit).
    pub async fn shutdown_all(&self) {
        let mut map = self.sessions.write().await;
        for (_, mut session) in map.drain() {
            if let Some(mut child) = session.child.take() {
                let _ = child.start_kill();
            }
            let _ = fs::remove_dir_all(&session.temp_dir);
        }
    }
}
