use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::{debug, info};

use crate::error::AppError;
use crate::metadata::{find_ffmpeg, NoWindowCommandExt};

/// Returns the local poster cache directory (%LOCALAPPDATA%\Monolith\cache\posters).
pub fn get_poster_cache_dir() -> PathBuf {
    if let Some(local_app_data) = dirs::data_local_dir() {
        local_app_data.join("Monolith").join("cache").join("posters")
    } else {
        std::env::temp_dir().join("Monolith").join("cache").join("posters")
    }
}

/// Returns the expected cached poster path for a given file hash.
pub fn get_cached_poster_path(file_hash: &str) -> PathBuf {
    get_poster_cache_dir().join(format!("{}.jpg", file_hash))
}

/// Validates whether a file is a valid non-empty JPEG image.
fn is_valid_jpeg(path: &Path) -> bool {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > 100 {
            if let Ok(bytes) = fs::read(path) {
                if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
                    return true;
                }
            }
        }
    }
    false
}

/// Extracts embedded cover art from media file, with video frame fallback.
/// Caches the resulting JPEG at `%LOCALAPPDATA%\Monolith\cache\posters\<hash>.jpg`.
pub fn extract_or_get_poster(media_path: &Path, file_hash: &str) -> Result<PathBuf, AppError> {
    if !media_path.exists() {
        return Err(AppError::NotFound(format!(
            "Media file not found for poster extraction: {}",
            media_path.display()
        )));
    }

    let cache_dir = get_poster_cache_dir();
    fs::create_dir_all(&cache_dir)?;

    let target_poster_path = get_cached_poster_path(file_hash);

    // If poster already cached and valid, return it immediately
    if target_poster_path.exists() && is_valid_jpeg(&target_poster_path) {
        debug!(
            "Poster cache hit for hash {}: {}",
            file_hash,
            target_poster_path.display()
        );
        return Ok(target_poster_path);
    }

    let ffmpeg = find_ffmpeg();
    let temp_target = cache_dir.join(format!("{}.tmp.jpg", file_hash));
    let media_str = media_path.to_string_lossy();
    let temp_str = temp_target.to_string_lossy();

    // 1. Attempt embedded cover extraction
    // Try MKV attachment mapping (-map 0:m:filename:cover.jpg or -map 0:t:0)
    let mkv_status = Command::new(&ffmpeg)
        .no_window()
        .args([
            "-y",
            "-v",
            "quiet",
            "-i",
            media_str.as_ref(),
            "-map",
            "0:m:filename:cover.jpg",
            "-c",
            "copy",
            "-update",
            "1",
            temp_str.as_ref(),
        ])
        .status();

    if mkv_status.is_ok() && temp_target.exists() && is_valid_jpeg(&temp_target) {
        let _ = fs::rename(&temp_target, &target_poster_path);
        info!("Extracted embedded MKV cover to {}", target_poster_path.display());
        return Ok(target_poster_path);
    }
    let _ = fs::remove_file(&temp_target);

    // Try MKV attachment index 0 (-map 0:t:0)
    let mkv_att_status = Command::new(&ffmpeg)
        .no_window()
        .args([
            "-y",
            "-v",
            "quiet",
            "-i",
            media_str.as_ref(),
            "-map",
            "0:t:0",
            "-c",
            "copy",
            "-update",
            "1",
            temp_str.as_ref(),
        ])
        .status();

    if mkv_att_status.is_ok() && temp_target.exists() && is_valid_jpeg(&temp_target) {
        let _ = fs::rename(&temp_target, &target_poster_path);
        info!("Extracted embedded MKV attachment to {}", target_poster_path.display());
        return Ok(target_poster_path);
    }
    let _ = fs::remove_file(&temp_target);

    // Try MP4 attached_pic / second video stream (-map 0:v:1)
    let mp4_status = Command::new(&ffmpeg)
        .no_window()
        .args([
            "-y",
            "-v",
            "quiet",
            "-i",
            media_str.as_ref(),
            "-map",
            "0:v:1",
            "-c",
            "copy",
            "-update",
            "1",
            temp_str.as_ref(),
        ])
        .status();

    if mp4_status.is_ok() && temp_target.exists() && is_valid_jpeg(&temp_target) {
        let _ = fs::rename(&temp_target, &target_poster_path);
        info!("Extracted embedded MP4 cover to {}", target_poster_path.display());
        return Ok(target_poster_path);
    }
    let _ = fs::remove_file(&temp_target);

    // Try general embedded cover (-an -vcodec copy -frames:v 1 -update 1 -f image2)
    let general_status = Command::new(&ffmpeg)
        .no_window()
        .args([
            "-y",
            "-v",
            "quiet",
            "-i",
            media_str.as_ref(),
            "-an",
            "-vcodec",
            "copy",
            "-frames:v",
            "1",
            "-update",
            "1",
            "-f",
            "image2",
            temp_str.as_ref(),
        ])
        .status();

    if general_status.is_ok() && temp_target.exists() && is_valid_jpeg(&temp_target) {
        let _ = fs::rename(&temp_target, &target_poster_path);
        info!("Extracted general embedded cover to {}", target_poster_path.display());
        return Ok(target_poster_path);
    }
    let _ = fs::remove_file(&temp_target);

    // 2. Video Frame Thumbnail Fallback (Seek 10s or 2s if short video)
    for seek_time in ["00:00:10", "00:00:02", "00:00:01", "00:00:00"] {
        let frame_status = Command::new(&ffmpeg)
            .no_window()
            .args([
                "-y",
                "-v",
                "quiet",
                "-ss",
                seek_time,
                "-i",
                media_str.as_ref(),
                "-vframes",
                "1",
                "-q:v",
                "2",
                "-update",
                "1",
                "-f",
                "image2",
                temp_str.as_ref(),
            ])
            .status();

        if frame_status.is_ok() && temp_target.exists() && is_valid_jpeg(&temp_target) {
            let _ = fs::rename(&temp_target, &target_poster_path);
            info!(
                "Generated video frame thumbnail (seek {}) to {}",
                seek_time,
                target_poster_path.display()
            );
            return Ok(target_poster_path);
        }
        let _ = fs::remove_file(&temp_target);
    }

    Err(AppError::ProcessError(format!(
        "Failed to extract poster or video frame fallback for {}",
        media_path.display()
    )))
}
