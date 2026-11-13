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

/// Appends shared HLS fragmented-MP4 output arguments across all transcode modes.
fn extend_hls_fmp4_args(args: &mut Vec<String>, output_str: String) {
    args.extend([
        "-f".to_string(),
        "hls".to_string(),
        "-hls_time".to_string(),
        "2".to_string(),
        "-hls_playlist_type".to_string(),
        "event".to_string(),
        "-hls_segment_type".to_string(),
        "fmp4".to_string(),
        "-hls_fmp4_init_filename".to_string(),
        "init.mp4".to_string(),
        "-hls_flags".to_string(),
        "independent_segments+temp_file".to_string(),
        "-hls_list_size".to_string(),
        "0".to_string(),
        output_str,
    ]);
}

/// Normalizes an optional target width cap into 720p-class (1280) or QHD/FHD-class (2560).
pub fn normalize_max_width(max_width: Option<u32>) -> u32 {
    match max_width {
        Some(w) if w <= 1280 => 1280,
        _ => 2560,
    }
}

/// Builds FFmpeg command line arguments for HLS dynamic transcoding starting at `start_seconds`.
pub fn build_ffmpeg_transcode_args_from(
    mode: &TranscodeMode,
    input_path: &Path,
    output_playlist: &Path,
    audio_index: u32,
    start_seconds: u64,
) -> Vec<String> {
    build_ffmpeg_transcode_args_with_options(
        mode,
        input_path,
        output_playlist,
        audio_index,
        start_seconds,
        2560,
    )
}

/// Builds FFmpeg command line arguments with an explicit `max_width` cap (1280 low-bandwidth, 2560 QHD/FHD default).
pub fn build_ffmpeg_transcode_args_with_options(
    mode: &TranscodeMode,
    input_path: &Path,
    output_playlist: &Path,
    audio_index: u32,
    start_seconds: u64,
    max_width: u32,
) -> Vec<String> {
    let mut args = Vec::new();

    let input_str = input_path.to_string_lossy().into_owned();
    let output_str = output_playlist.to_string_lossy().into_owned();
    let capped_w = normalize_max_width(Some(max_width));
    let (level, v_bitrate, v_maxrate, v_bufsize, a_bitrate) = if capped_w <= 1280 {
        ("4.0", "2000k", "2500k", "5000k", "128k")
    } else {
        ("5.0", "7500k", "9M", "18M", "192k")
    };
    // GPU-resident max scale & 8-bit nv12 conversion keeps 4K 10-bit HEVC transcodes ~7-10x realtime.
    let cuda_mobile_safe_vf = format!("scale_cuda=w='min({},iw)':h=-2:format=nv12", capped_w);
    let cpu_mobile_safe_vf = format!("scale=w='min({},iw)':h=-2,format=yuv420p", capped_w);

    match mode {
        TranscodeMode::NvencCuda => {
            args.extend([
                "-hwaccel".to_string(),
                "cuda".to_string(),
                "-hwaccel_output_format".to_string(),
                "cuda".to_string(),
            ]);
            if start_seconds > 0 {
                args.extend(["-ss".to_string(), start_seconds.to_string()]);
            }
            args.extend([
                "-i".to_string(),
                input_str,
                "-avoid_negative_ts".to_string(),
                "make_zero".to_string(),
                "-vf".to_string(),
                cuda_mobile_safe_vf,
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-profile:v".to_string(),
                "high".to_string(),
                "-level:v".to_string(),
                level.to_string(),
                "-preset".to_string(),
                "p1".to_string(),
                "-tune".to_string(),
                "ll".to_string(),
                "-b:v".to_string(),
                v_bitrate.to_string(),
                "-maxrate".to_string(),
                v_maxrate.to_string(),
                "-bufsize".to_string(),
                v_bufsize.to_string(),
                "-g".to_string(),
                "48".to_string(),
                "-map".to_string(),
                "0:v:0".to_string(),
                "-map".to_string(),
                format!("0:a:{}?", audio_index),
                "-c:a".to_string(),
                "aac".to_string(),
                "-ac".to_string(),
                "2".to_string(),
                "-b:a".to_string(),
                a_bitrate.to_string(),
            ]);
            extend_hls_fmp4_args(&mut args, output_str);
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
                cpu_mobile_safe_vf,
                "-c:v".to_string(),
                "libx264".to_string(),
                "-profile:v".to_string(),
                "high".to_string(),
                "-level:v".to_string(),
                level.to_string(),
                "-preset".to_string(),
                "ultrafast".to_string(),
                "-tune".to_string(),
                "zerolatency".to_string(),
                "-b:v".to_string(),
                v_bitrate.to_string(),
                "-maxrate".to_string(),
                v_maxrate.to_string(),
                "-bufsize".to_string(),
                v_bufsize.to_string(),
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
                a_bitrate.to_string(),
            ]);
            extend_hls_fmp4_args(&mut args, output_str);
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
                a_bitrate.to_string(),
            ]);
            extend_hls_fmp4_args(&mut args, output_str);
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
    generate_master_playlist_with_options(
        media_id,
        width,
        height,
        audio_index,
        start_seconds,
        invite_token,
        None,
    )
}

/// Generates HLS master playlist content with optional start offset, invite token, and resolution cap.
pub fn generate_master_playlist_with_options(
    media_id: &str,
    width: u32,
    height: u32,
    audio_index: Option<u32>,
    start_seconds: Option<u64>,
    invite_token: Option<&str>,
    max_width: Option<u32>,
) -> String {
    let cap_w = normalize_max_width(max_width);
    let raw_w = if width > 0 { width } else { 1920 };
    let raw_h = if height > 0 { height } else { 1080 };
    let (w, h) = if raw_w > cap_w {
        let scaled_h = (((raw_h as f64) * (cap_w as f64) / (raw_w as f64)).round() as u32) & !1;
        (cap_w, scaled_h.max(2))
    } else {
        (raw_w, raw_h)
    };

    let audio = audio_index.unwrap_or(0);
    let start = start_seconds.unwrap_or(0);
    let base_path = if cap_w <= 1280 {
        format!("/api/stream/{}/v/{}/{}/{}/index.m3u8", media_id, cap_w, audio, start)
    } else {
        format!("/api/stream/{}/s/{}/{}/index.m3u8", media_id, audio, start)
    };
    let variant_uri = match invite_token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(tok) => format!("{}?invite={}", base_path, tok),
        None => base_path,
    };
    let (bandwidth, codecs) = if cap_w <= 1280 {
        (2_500_000, "avc1.640028,mp4a.40.2")
    } else {
        (9_000_000, "avc1.640032,mp4a.40.2")
    };

    format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},CODECS=\"{}\"\n{}\n",
        bandwidth, w, h, codecs, variant_uri
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
        assert!(args.iter().any(|a| a == "cuda"));
        assert!(args.iter().any(|a| a.contains("scale_cuda") && a.contains("min(2560,iw)")));
        assert!(args.windows(2).any(|w| w[0] == "-b:v" && w[1] == "7500k"));
        assert!(args.windows(2).any(|w| w[0] == "-hls_segment_type" && w[1] == "fmp4"));
        assert!(args.windows(2).any(|w| w[0] == "-hls_fmp4_init_filename" && w[1] == "init.mp4"));

        let mobile_args = build_ffmpeg_transcode_args_with_options(
            &TranscodeMode::NvencCuda,
            Path::new("movie.mkv"),
            Path::new("index.m3u8"),
            0,
            0,
            1280,
        );
        assert!(mobile_args
            .iter()
            .any(|a| a.contains("scale_cuda") && a.contains("min(1280,iw)")));
        assert!(mobile_args.windows(2).any(|w| w[0] == "-b:v" && w[1] == "2000k"));

        let master = generate_master_playlist_with_params(
            "abc",
            3832,
            1600,
            Some(0),
            Some(879),
            Some("tok123"),
        );
        assert!(master.contains("#EXT-X-VERSION:7"));
        assert!(master.contains("RESOLUTION=2560x1068"));
        assert!(master.contains("CODECS=\"avc1.640032,mp4a.40.2\""));
        assert!(master.contains("/api/stream/abc/s/0/879/index.m3u8?invite=tok123"));

        let master_720 = generate_master_playlist_with_options(
            "abc",
            3840,
            2160,
            Some(0),
            Some(0),
            Some("tok123"),
            Some(1280),
        );
        assert!(master_720.contains("RESOLUTION=1280x720"));
        assert!(master_720.contains("CODECS=\"avc1.640028,mp4a.40.2\""));
        assert!(master_720.contains("/api/stream/abc/v/1280/0/0/index.m3u8?invite=tok123"));
    }
}
