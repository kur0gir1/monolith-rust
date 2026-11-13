use std::path::Path;

use crate::models::TranscodeMode;

/// Builds standard FFmpeg command line arguments for HLS dynamic transcoding.
pub fn build_ffmpeg_transcode_args(
    mode: &TranscodeMode,
    input_path: &Path,
    output_playlist: &Path,
    audio_index: u32,
) -> Vec<String> {
    build_ffmpeg_transcode_args_from(mode, input_path, output_playlist, audio_index, 0)
}

/// Builds FFmpeg command line arguments for HLS dynamic transcoding starting at `start_seconds`.
pub fn build_ffmpeg_transcode_args_from(
    mode: &TranscodeMode,
    input_path: &Path,
    output_playlist: &Path,
    audio_index: u32,
    start_seconds: u64,
) -> Vec<String> {
    let mut args = Vec::new();

    let input_str = input_path.to_string_lossy().into_owned();
    let output_str = output_playlist.to_string_lossy().into_owned();
    // Scale 4K/2160p sources down to max 1080p width with even height so mobile H.264 hardware decoders
    // and Watch Party tunnels stream smoothly without stalling.
    let mobile_safe_vf = "scale=w='min(1920,iw)':h=-2,format=yuv420p";

    match mode {
        TranscodeMode::NvencCuda => {
            args.extend(["-hwaccel".to_string(), "cuda".to_string()]);
            if start_seconds > 0 {
                args.extend(["-ss".to_string(), start_seconds.to_string()]);
            }
            args.extend([
                "-i".to_string(),
                input_str,
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
                "-vf".to_string(),
                mobile_safe_vf.to_string(),
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-profile:v".to_string(),
                "high".to_string(),
                "-level:v".to_string(),
                "4.1".to_string(),
                "-preset".to_string(),
                "p2".to_string(),
                "-tune".to_string(),
                "ll".to_string(),
                "-b:v".to_string(),
                "5M".to_string(),
                "-maxrate".to_string(),
                "5M".to_string(),
                "-bufsize".to_string(),
                "10M".to_string(),
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
            if start_seconds > 0 {
                args.extend(["-ss".to_string(), start_seconds.to_string()]);
            }
            args.extend([
                "-i".to_string(),
                input_str,
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
                "-vf".to_string(),
                mobile_safe_vf.to_string(),
                "-c:v".to_string(),
                "libx264".to_string(),
                "-profile:v".to_string(),
                "high".to_string(),
                "-level:v".to_string(),
                "4.1".to_string(),
                "-preset".to_string(),
                "ultrafast".to_string(),
                "-tune".to_string(),
                "zerolatency".to_string(),
                "-b:v".to_string(),
                "5M".to_string(),
                "-maxrate".to_string(),
                "5M".to_string(),
                "-bufsize".to_string(),
                "10M".to_string(),
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
            if start_seconds > 0 {
                args.extend(["-ss".to_string(), start_seconds.to_string()]);
            }
            args.extend([
                "-i".to_string(),
                input_str,
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
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
    generate_master_playlist_with_params(media_id, width, height, audio_index, None, None)
}

/// Generates HLS master playlist content with optional start offset and invite token forwarding.
pub fn generate_master_playlist_with_params(
    media_id: &str,
    width: u32,
    height: u32,
    audio_index: Option<u32>,
    start_seconds: Option<u64>,
    invite_token: Option<&str>,
) -> String {
    let raw_w = if width > 0 { width } else { 1920 };
    let raw_h = if height > 0 { height } else { 1080 };
    let (w, h) = if raw_w > 1920 {
        let scaled_h = (((raw_h as f64) * 1920.0 / (raw_w as f64)).round() as u32) & !1;
        (1920, scaled_h.max(2))
    } else {
        (raw_w, raw_h)
    };

    let mut query_parts = Vec::new();
    if let Some(idx) = audio_index {
        query_parts.push(format!("audio={}", idx));
    }
    if let Some(start) = start_seconds.filter(|&s| s > 0) {
        query_parts.push(format!("start={}", start));
    }
    if let Some(tok) = invite_token.map(str::trim).filter(|t| !t.is_empty()) {
        query_parts.push(format!("invite={}", tok));
    }

    let variant_uri = if query_parts.is_empty() {
        format!("/api/stream/{}/index.m3u8", media_id)
    } else {
        format!("/api/stream/{}/index.m3u8?{}", media_id, query_parts.join("&"))
    };

    format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION={}x{}\n{}\n",
        w, h, variant_uri
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_seek_and_4k_downscale_transcode_args() {
        let args = build_ffmpeg_transcode_args_from(
            &TranscodeMode::NvencCuda,
            Path::new("movie.mkv"),
            Path::new("index.m3u8"),
            1,
            879,
        );
        let ss_pos = args.iter().position(|a| a == "-ss").unwrap();
        let input_pos = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss_pos < input_pos);
        assert_eq!(args[ss_pos + 1], "879");
        assert!(args.iter().any(|a| a.contains("min(1920,iw)")));

        let master = generate_master_playlist_with_params(
            "abc",
            3832,
            1600,
            Some(0),
            Some(879),
            Some("tok123"),
        );
        assert!(master.contains("RESOLUTION=1920x802"));
        assert!(master.contains("/api/stream/abc/index.m3u8?audio=0&start=879&invite=tok123"));
    }
}
