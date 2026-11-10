use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::{debug, info};

use crate::error::AppError;
use crate::metadata::find_ffmpeg;

/// Extracts embedded subtitle stream to WebVTT format on-the-fly.
/// Command: `ffmpeg -y -v quiet -i <INPUT> -map 0:<SUB_INDEX> -f webvtt <OUTPUT_VTT>`
pub fn extract_webvtt_subtitles(
    media_path: &Path,
    sub_index: u32,
    output_path: &Path,
) -> Result<PathBuf, AppError> {
    if !media_path.exists() {
        return Err(AppError::NotFound(format!(
            "Media file not found for subtitle extraction: {}",
            media_path.display()
        )));
    }

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let ffmpeg = find_ffmpeg();
    debug!(
        "Extracting subtitle track {} from {} to {}",
        sub_index,
        media_path.display(),
        output_path.display()
    );

    let media_str = media_path.to_string_lossy();
    let out_str = output_path.to_string_lossy();
    let map_arg = format!("0:{}", sub_index);

    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-v",
            "quiet",
            "-i",
            media_str.as_ref(),
            "-map",
            &map_arg,
            "-f",
            "webvtt",
            out_str.as_ref(),
        ])
        .status()
        .map_err(|e| AppError::ProcessError(format!("Failed to spawn ffmpeg: {}", e)))?;

    if !status.success() {
        return Err(AppError::TranscodeError(format!(
            "FFmpeg subtitle extraction failed for stream index {} on {}",
            sub_index,
            media_path.display()
        )));
    }

    if !output_path.exists() {
        return Err(AppError::TranscodeError(format!(
            "Output WebVTT file was not created: {}",
            output_path.display()
        )));
    }

    info!(
        "Successfully extracted WebVTT subtitles to {}",
        output_path.display()
    );
    Ok(output_path.to_path_buf())
}
