use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::path::PathBuf;

use crate::app_state::AppState;
use crate::error::AppError;
use crate::transcoder::{extract_webvtt_subtitles, generate_master_playlist_with_params};

#[derive(Debug, Deserialize)]
pub struct AudioQuery {
    pub audio: Option<u32>,
    pub start: Option<u64>,
    pub invite: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SwitchAudioRequest {
    pub audio_index: u32,
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

    let invite = query.invite.clone().or_else(|| {
        req_headers
            .get("x-monolith-invite")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });

    let playlist_content = generate_master_playlist_with_params(
        &id,
        width,
        height,
        query.audio,
        query.start,
        invite.as_deref(),
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

/// GET /api/stream/:id/index.m3u8
pub async fn get_variant_playlist(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<AudioQuery>,
) -> Result<Response, AppError> {
    let item = state
        .get_item(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    let audio_index = query.audio.unwrap_or(0);
    let start_seconds = query.start.unwrap_or(0);
    let media_path = PathBuf::from(&item.file_path);
    let video_codec = item.metadata.as_ref().map(|m| m.video_codec.as_str());

    let _stream_info = state
        .transcode_sessions
        .start_or_get_session_at(&id, &media_path, audio_index, video_codec, start_seconds)
        .await?;

    let temp_dir = state
        .transcode_sessions
        .get_session_temp_dir(&id)
        .await
        .ok_or_else(|| AppError::TranscodeError("Failed to find session temp directory".to_string()))?;

    let playlist_file = temp_dir.join("index.m3u8");

    if !playlist_file.exists() {
        return Err(AppError::TranscodeError("HLS playlist not ready yet".to_string()));
    }

    let content = tokio::fs::read_to_string(&playlist_file).await?;

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

/// GET /api/stream/:id/:segment
pub async fn get_segment(
    State(state): State<AppState>,
    AxumPath((id, segment)): AxumPath<(String, String)>,
) -> Result<Response, AppError> {
    // Prevent directory traversal attacks
    if segment.contains("..") || segment.contains('/') || segment.contains('\\') {
        return Err(AppError::InvalidPath("Invalid segment filename".to_string()));
    }

    let temp_dir = state
        .transcode_sessions
        .get_session_temp_dir(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    let segment_path = temp_dir.join(&segment);

    if !segment_path.exists() {
        return Err(AppError::NotFound(format!("Segment {} not found", segment)));
    }

    let bytes = tokio::fs::read(&segment_path).await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("video/mp2t"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("max-age=3600"),
    );

    Ok((StatusCode::OK, headers, bytes).into_response())
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
