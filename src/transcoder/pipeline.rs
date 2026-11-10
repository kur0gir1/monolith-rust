use std::path::Path;

use crate::models::TranscodeMode;

/// Builds standard FFmpeg command line arguments for HLS dynamic transcoding.
pub fn build_ffmpeg_transcode_args(
    mode: &TranscodeMode,
    input_path: &Path,
    output_playlist: &Path,
    audio_index: u32,
) -> Vec<String> {
    let mut args = Vec::new();

    let input_str = input_path.to_string_lossy().into_owned();
    let output_str = output_playlist.to_string_lossy().into_owned();

    match mode {
        TranscodeMode::NvencCuda => {
            args.extend([
                "-hwaccel".to_string(),
                "cuda".to_string(),
                "-i".to_string(),
                input_str,
                "-vf".to_string(),
                "format=yuv420p".to_string(),
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p2".to_string(),
                "-tune".to_string(),
                "ll".to_string(),
                "-b:v".to_string(),
                "5M".to_string(),
                "-g".to_string(),
                "48".to_string(),
                "-sc_threshold".to_string(),
                "0".to_string(),
                "-map".to_string(),
                "0:v:0".to_string(),
                "-map".to_string(),
                format!("0:a:{}?", audio_index),
                "-c:a".to_string(),
                "aac".to_string(),
                "-ac".to_string(),
                "2".to_string(),
                "-b:a".to_string(),
                "160k".to_string(),
                "-f".to_string(),
                "hls".to_string(),
                "-hls_time".to_string(),
                "2".to_string(),
                "-hls_playlist_type".to_string(),
                "event".to_string(),
                "-hls_flags".to_string(),
                "independent_segments+temp_file".to_string(),
                "-hls_list_size".to_string(),
                "0".to_string(),
                output_str,
            ]);
        }
        TranscodeMode::CpuLibx264 => {
            args.extend([
                "-i".to_string(),
                input_str,
                "-vf".to_string(),
                "format=yuv420p".to_string(),
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "ultrafast".to_string(),
                "-tune".to_string(),
                "zerolatency".to_string(),
                "-b:v".to_string(),
                "5M".to_string(),
                "-g".to_string(),
                "48".to_string(),
                "-sc_threshold".to_string(),
                "0".to_string(),
                "-map".to_string(),
                "0:v:0".to_string(),
                "-map".to_string(),
                format!("0:a:{}?", audio_index),
                "-c:a".to_string(),
                "aac".to_string(),
                "-ac".to_string(),
                "2".to_string(),
                "-b:a".to_string(),
                "160k".to_string(),
                "-f".to_string(),
                "hls".to_string(),
                "-hls_time".to_string(),
                "2".to_string(),
                "-hls_playlist_type".to_string(),
                "event".to_string(),
                "-hls_flags".to_string(),
                "independent_segments+temp_file".to_string(),
                "-hls_list_size".to_string(),
                "0".to_string(),
                output_str,
            ]);
        }
        TranscodeMode::DirectStream => {
            args.extend([
                "-i".to_string(),
                input_str,
                "-c:v".to_string(),
                "copy".to_string(),
                "-map".to_string(),
                "0:v:0".to_string(),
                "-map".to_string(),
                format!("0:a:{}?", audio_index),
                "-c:a".to_string(),
                "aac".to_string(),
                "-ac".to_string(),
                "2".to_string(),
                "-b:a".to_string(),
                "160k".to_string(),
                "-f".to_string(),
                "hls".to_string(),
                "-hls_time".to_string(),
                "2".to_string(),
                "-hls_playlist_type".to_string(),
                "event".to_string(),
                "-hls_flags".to_string(),
                "independent_segments+temp_file".to_string(),
                "-hls_list_size".to_string(),
                "0".to_string(),
                output_str,
            ]);
        }
    }

    args
}

/// Generates HLS master playlist content referencing the variant playlist.
pub fn generate_master_playlist(
    media_id: &str,
    width: u32,
    height: u32,
    audio_index: Option<u32>,
) -> String {
    let w = if width > 0 { width } else { 1920 };
    let h = if height > 0 { height } else { 1080 };
    let variant_uri = match audio_index {
        Some(idx) => format!("/api/stream/{}/index.m3u8?audio={}", media_id, idx),
        None => format!("/api/stream/{}/index.m3u8", media_id),
    };

    format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION={}x{}\n{}\n",
        w, h, variant_uri
    )
}
