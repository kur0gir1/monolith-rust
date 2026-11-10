use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

use crate::app_state::AppState;
use crate::error::AppError;
use crate::metadata::probe_media_file;
use crate::models::MediaItem;
use crate::poster::extract_or_get_poster;
use crate::scanner::scan_directory;
use crate::transcoder::probe_nvenc_available;

#[derive(Debug, Deserialize)]
pub struct ScanRequest {
    pub path: Option<String>,
}

/// GET /api/media
pub async fn get_media_index(State(state): State<AppState>) -> Json<Vec<MediaItem>> {
    let items = state.get_all_items().await;
    Json(items)
}

/// GET /api/media/:id
pub async fn get_media_by_id(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<MediaItem>, AppError> {
    let item = state
        .get_item(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;
    Ok(Json(item))
}

/// GET /api/media/:id/poster
pub async fn get_poster(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, AppError> {
    let item = state
        .get_item(&id)
        .await
        .ok_or_else(|| AppError::MediaNotFound(id.clone()))?;

    let media_path = PathBuf::from(&item.file_path);
    let id_clone = id.clone();
    let poster_path = tokio::task::spawn_blocking(move || extract_or_get_poster(&media_path, &id_clone))
        .await
        .map_err(|e| AppError::JoinError(e.to_string()))??;

    let bytes = tokio::fs::read(&poster_path).await?;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );

    Ok((StatusCode::OK, headers, bytes).into_response())
}

/// POST /api/scan
pub async fn trigger_scan(
    State(state): State<AppState>,
    Json(payload): Json<ScanRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let existing_root = state.get_selected_directory().await;
    let scan_dir_str = match (payload.path, existing_root) {
        (Some(p), Some(ref root)) => {
            // If a library root is already configured, only allow scanning within that root
            let req_canon = fs::canonicalize(&p).unwrap_or_else(|_| PathBuf::from(&p));
            let root_canon = fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
            if !req_canon.starts_with(&root_canon) && req_canon != root_canon {
                return Err(AppError::InvalidPath(
                    "Changing scan root outside active media library over HTTP is not permitted".to_string(),
                ));
            }
            p
        }
        (Some(p), None) => p,
        (None, Some(root)) => root,
        (None, None) => {
            return Err(AppError::InvalidPath(
                "No directory path specified or selected".to_string(),
            ))
        }
    };

    let target_dir = PathBuf::from(&scan_dir_str);
    if !target_dir.exists() {
        return Err(AppError::NotFound(format!(
            "Target scan directory does not exist: {}",
            scan_dir_str
        )));
    }

    state
        .set_selected_directory(Some(scan_dir_str.clone()))
        .await;

    info!("Initiating media library scan for: {}", scan_dir_str);
    let scanned_items = tokio::task::spawn_blocking(move || -> Result<Vec<MediaItem>, AppError> {
        let mut items = scan_directory(&target_dir)?;
        for item in &mut items {
            let p = Path::new(&item.file_path);
            match probe_media_file(p) {
                Ok(meta) => {
                    item.metadata = Some(meta);
                }
                Err(e) => {
                    warn!("Metadata probe skipped for {}: {}", item.file_path, e);
                }
            }

            match extract_or_get_poster(p, &item.id) {
                Ok(poster) => {
                    item.poster_path = Some(poster.to_string_lossy().to_string());
                }
                Err(e) => {
                    debug!("Poster extraction skipped for {}: {}", item.file_path, e);
                }
            }
        }
        Ok(items)
    })
    .await
    .map_err(|e| AppError::JoinError(e.to_string()))??;

    let count = scanned_items.len();
    state.set_items(scanned_items).await;
    info!("Scan complete. Indexed {} items.", count);

    Ok(Json(serde_json::json!({
        "status": "scanned",
        "count": count
    })))
}

/// GET /api/status
pub async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let lan_ip = match local_ip_address::local_ip() {
        Ok(ip) => ip.to_string(),
        Err(_) => "127.0.0.1".to_string(),
    };

    let gpu_available = tokio::task::spawn_blocking(probe_nvenc_available)
        .await
        .unwrap_or(false);
    let transcoder = if gpu_available {
        "NVENC CUDA".to_string()
    } else {
        "CPU LIBX264".to_string()
    };
    let selected_directory = state.get_selected_directory().await;

    Json(serde_json::json!({
        "lan_ip": lan_ip,
        "port": 9000,
        "gpu_available": gpu_available,
        "transcoder": transcoder,
        "selected_directory": selected_directory
    }))
}
