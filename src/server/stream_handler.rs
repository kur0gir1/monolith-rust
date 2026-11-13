use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::path::PathBuf;

use crate::app_state::AppState;
use crate::error::AppError;
use crate::transcoder::{
    extract_webvtt_subtitles, generate_master_playlist_with_options, normalize_max_width,
};

#[derive(Debug, Deserialize)]
pub struct AudioQuery {
    pub audio: Option<u32>,
    pub start: Option<u64>,
    pub invite: Option<String>,
    pub q: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct SwitchAudioRequest {
    pub audio_index: u32,
}

fn extract_invite(req_headers: &HeaderMap, query: &AudioQuery) -> Option<String> {
    query
        .invite
        .clone()
        .or_else(|| {
            req_headers
                .get("x-monolith-invite")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim().to_string())
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn rewrite_map_uri(line: &str, tok: &str) -> String {
    let Some(start) = line.find("URI=\"") else {
        return line.to_string();
    };
    let uri_start = start + 5;
    let Some(rel_end) = line[uri_start..].find('"') else {
        return line.to_string();
    };
    let uri = &line[uri_start..uri_start + rel_end];
    if uri.contains("invite=") {
        return line.to_string();
    }
    let sep = if uri.contains('?') { '&' } else { '?' };
    format!(
        "{}{}{}invite={}{}",
        &line[..uri_start],
        uri,
        sep,
        tok,
        &line[uri_start + rel_end..]
    )
}

fn append_invite_to_segments(playlist: &str, invite_token: Option<&str>) -> String {
    let Some(tok) = invite_token.map(str::trim).filter(|t| !t.is_empty()) else {
        return playlist.to_string();
    };
    playlist
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("#EXT-X-MAP:") {
                rewrite_map_uri(line, tok)
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.contains("invite=") {
                let sep = if trimmed.contains('?') { '&' } else { '?' };
                format!("{}{}invite={}", trimmed, sep, tok)
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + if playlist.ends_with('\n') { "\n" } else { "" }
}

/// GET /api/stream/:id/master.m3u8
pub async fn get_master_playlist(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    req_headers: HeaderMap,
    Query(query): Query<AudioQuery>,
) -> Result<Response, AppError> {
    let item = state
        .get_item(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    let (width, height) = if let Some(ref meta) = item.metadata {
        (meta.width, meta.height)
    } else {
        (1920, 1080)
    };

    let invite = extract_invite(&req_headers, &query);
    let max_width = query.q.map(|q| normalize_max_width(Some(if q <= 720 { 1280 } else { q })));

    let playlist_content = generate_master_playlist_with_options(
        &id,
        width,
        height,
        query.audio,
        query.start,
        invite.as_deref(),
        max_width,
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.apple.mpegurl"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );

    Ok((StatusCode::OK, headers, playlist_content).into_response())
}

async fn serve_variant_playlist(
    state: &AppState,
    id: &str,
    audio_index: u32,
    start_seconds: u64,
    max_width: u32,
    invite_token: Option<&str>,
) -> Result<Response, AppError> {
    let item = state
        .get_item(id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.to_string()))?;

    let media_path = PathBuf::from(&item.file_path);
    let video_codec = item.metadata.as_ref().map(|m| m.video_codec.as_str());
    let capped_w = normalize_max_width(Some(max_width));

    state
        .transcode_sessions
        .start_or_get_session_with_width(id, &media_path, audio_index, video_codec, start_seconds, capped_w)
        .await?;

    let temp_dir = state
        .transcode_sessions
        .get_session_temp_dir_with_width(id, audio_index, start_seconds, capped_w)
        .await
        .ok_or_else(|| AppError::TranscodeError("Failed to find session temp directory".to_string()))?;

    let playlist_file = temp_dir.join("index.m3u8");
    if !playlist_file.exists() {
        return Err(AppError::TranscodeError("HLS playlist not ready yet".to_string()));
    }

    let raw_content = tokio::fs::read_to_string(&playlist_file).await?;
    let content = append_invite_to_segments(&raw_content, invite_token);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.apple.mpegurl"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );

    Ok((StatusCode::OK, headers, content).into_response())
}

async fn serve_segment_from_dir(temp_dir: PathBuf, segment: &str) -> Result<Response, AppError> {
    let segment_path = temp_dir.join(segment);
    if !segment_path.exists() {
        return Err(AppError::NotFound(format!("Segment {} not found", segment)));
    }

    let bytes = tokio::fs::read(&segment_path).await?;
    let content_type = if segment.ends_with(".m4s") || segment.ends_with(".mp4") {
        "video/mp4"
    } else if segment.ends_with(".ts") {
        "video/mp2t"
    } else {
        "application/octet-stream"
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("max-age=3600"),
    );

    Ok((StatusCode::OK, headers, bytes).into_response())
}

/// GET /api/stream/:id/index.m3u8
pub async fn get_variant_playlist(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    req_headers: HeaderMap,
    Query(query): Query<AudioQuery>,
) -> Result<Response, AppError> {
    let invite = extract_invite(&req_headers, &query);
    let max_width = normalize_max_width(query.q.map(|q| if q <= 720 { 1280 } else { q }));
    serve_variant_playlist(
        &state,
        &id,
        query.audio.unwrap_or(0),
        query.start.unwrap_or(0),
        max_width,
        invite.as_deref(),
    )
    .await
}

/// GET /api/stream/:id/s/:audio/:start/index.m3u8
pub async fn get_scoped_variant_playlist(
    State(state): State<AppState>,
    AxumPath((id, audio, start)): AxumPath<(String, u32, u64)>,
    req_headers: HeaderMap,
    Query(query): Query<AudioQuery>,
) -> Result<Response, AppError> {
    let invite = extract_invite(&req_headers, &query);
    serve_variant_playlist(&state, &id, audio, start, 1920, invite.as_deref()).await
}

/// GET /api/stream/:id/v/:max_w/:audio/:start/index.m3u8
pub async fn get_quality_variant_playlist(
    State(state): State<AppState>,
    AxumPath((id, max_w, audio, start)): AxumPath<(String, u32, u32, u64)>,
    req_headers: HeaderMap,
    Query(query): Query<AudioQuery>,
) -> Result<Response, AppError> {
    let invite = extract_invite(&req_headers, &query);
    serve_variant_playlist(&state, &id, audio, start, max_w, invite.as_deref()).await
}

/// GET /api/stream/:id/v/:max_w/:audio/:start/:segment
pub async fn get_quality_scoped_segment(
    State(state): State<AppState>,
    AxumPath((id, max_w, audio, start, segment)): AxumPath<(String, u32, u32, u64, String)>,
) -> Result<Response, AppError> {
    if segment.contains("..") || segment.contains('/') || segment.contains('\\') {
        return Err(AppError::InvalidPath("Invalid segment filename".to_string()));
    }

    let capped_w = normalize_max_width(Some(max_w));
    let temp_dir = state
        .transcode_sessions
        .get_session_temp_dir_with_width(&id, audio, start, capped_w)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    serve_segment_from_dir(temp_dir, &segment).await
}

/// GET /api/stream/:id/s/:audio/:start/:segment
pub async fn get_scoped_segment(
    State(state): State<AppState>,
    AxumPath((id, audio, start, segment)): AxumPath<(String, u32, u64, String)>,
) -> Result<Response, AppError> {
    if segment.contains("..") || segment.contains('/') || segment.contains('\\') {
        return Err(AppError::InvalidPath("Invalid segment filename".to_string()));
    }

    let temp_dir = state
        .transcode_sessions
        .get_session_temp_dir_at(&id, audio, start)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    serve_segment_from_dir(temp_dir, &segment).await
}

/// GET /api/stream/:id/:segment
pub async fn get_segment(
    State(state): State<AppState>,
    AxumPath((id, segment)): AxumPath<(String, String)>,
) -> Result<Response, AppError> {
    if segment.contains("..") || segment.contains('/') || segment.contains('\\') {
        return Err(AppError::InvalidPath("Invalid segment filename".to_string()));
    }

    let temp_dir = state
        .transcode_sessions
        .get_session_temp_dir(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    serve_segment_from_dir(temp_dir, &segment).await
}

/// GET /api/stream/:id/subtitles/:sub_index/subs.vtt
pub async fn get_subtitles(
    State(state): State<AppState>,
    AxumPath((id, sub_index)): AxumPath<(String, u32)>,
) -> Result<Response, AppError> {
    let item = state
        .get_item(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    let media_path = PathBuf::from(&item.file_path);
    let vtt_cache_path = std::env::temp_dir()
        .join(format!("monolith_subs_{}_{}.vtt", id, sub_index));

    if !vtt_cache_path.exists() {
        let vtt_clone = vtt_cache_path.clone();
        tokio::task::spawn_blocking(move || {
            extract_webvtt_subtitles(&media_path, sub_index, &vtt_clone)
        })
        .await
        .map_err(|e| AppError::JoinError(e.to_string()))??;
    }

    let vtt_content = tokio::fs::read_to_string(&vtt_cache_path).await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/vtt; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("max-age=86400"),
    );

    Ok((StatusCode::OK, headers, vtt_content).into_response())
}

/// POST /api/stream/:id/audio
pub async fn switch_audio(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<SwitchAudioRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let item = state
        .get_item(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    let media_path = PathBuf::from(&item.file_path);
    let video_codec = item.metadata.as_ref().map(|m| m.video_codec.as_str());

    state
        .transcode_sessions
        .switch_audio_track(&id, &media_path, payload.audio_index, video_codec)
        .await?;

    Ok(Json(serde_json::json!({
        "status": "switched",
        "audio_index": payload.audio_index
    })))
}

#[cfg(test)]
mod tests {
    use super::append_invite_to_segments;

    #[test]
    fn test_append_invite_to_segments() {
        let raw = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.002,\nindex0.m4s\n#EXTINF:2.002,\nindex1.m4s\n";
        let rewritten = append_invite_to_segments(raw, Some("tok123"));
        assert!(rewritten.contains("#EXT-X-MAP:URI=\"init.mp4?invite=tok123\""));
        assert!(rewritten.contains("index0.m4s?invite=tok123"));
        assert!(rewritten.contains("index1.m4s?invite=tok123"));
        assert!(rewritten.contains("#EXTM3U\n#EXT-X-VERSION:7"));
        assert_eq!(append_invite_to_segments(raw, None), raw);
    }
}
