use axum::extract::{Path as AxumPath, Query, State};
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
use crate::party::{PartyState, PartyUpdateRequest};
use crate::poster::extract_or_get_poster;
use crate::scanner::scan_directory;
use crate::transcoder::probe_nvenc_available;
use crate::tunnel::{TunnelProvider, TunnelStatus};

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
    let tunnel = state.tunnel.get_status().await;

    Json(serde_json::json!({
        "lan_ip": lan_ip,
        "port": 9000,
        "gpu_available": gpu_available,
        "transcoder": transcoder,
        "selected_directory": selected_directory,
        "tunnel": tunnel
    }))
}

#[derive(Debug, Deserialize)]
pub struct TunnelStartRequest {
    pub provider: Option<String>,
}

/// GET /api/tunnel
pub async fn get_tunnel_status(State(state): State<AppState>) -> Json<TunnelStatus> {
    Json(state.tunnel.get_status().await)
}

/// POST /api/tunnel/start
pub async fn start_tunnel(
    State(state): State<AppState>,
    Json(payload): Json<TunnelStartRequest>,
) -> Json<TunnelStatus> {
    let provider = TunnelProvider::from_str_opt(payload.provider.as_deref());
    let status = state.tunnel.start(provider, 9000).await;
    Json(status)
}

/// POST /api/tunnel/stop
pub async fn stop_tunnel(State(state): State<AppState>) -> Json<TunnelStatus> {
    Json(state.tunnel.stop().await)
}

/// POST /api/tunnel/kill
pub async fn kill_tunnel(State(state): State<AppState>) -> Json<TunnelStatus> {
    state.party.reset().await;
    Json(state.tunnel.kill().await)
}

/// POST /api/tunnel/rotate
pub async fn rotate_tunnel_token(State(state): State<AppState>) -> Json<TunnelStatus> {
    Json(state.tunnel.rotate_token().await)
}

#[derive(Debug, Deserialize)]
pub struct PartyQuery {
    pub peer_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PartyLeaveRequest {
    pub peer_id: Option<String>,
}

/// GET /api/party
pub async fn get_party_state(
    State(state): State<AppState>,
    Query(query): Query<PartyQuery>,
) -> Json<PartyState> {
    Json(state.party.get_state(query.peer_id.as_deref()).await)
}

/// POST /api/party
pub async fn update_party_state(
    State(state): State<AppState>,
    Json(payload): Json<PartyUpdateRequest>,
) -> Json<PartyState> {
    Json(state.party.update(payload).await)
}

/// POST /api/party/leave
pub async fn leave_party(
    State(state): State<AppState>,
    Json(payload): Json<PartyLeaveRequest>,
) -> Json<PartyState> {
    if let Some(id) = payload.peer_id {
        Json(state.party.remove_peer(&id).await)
    } else {
        Json(state.party.get_state(None).await)
    }
}

/// POST /api/party/reset
pub async fn reset_party(State(state): State<AppState>) -> Json<PartyState> {
    Json(state.party.reset().await)
}

#[derive(Debug, Deserialize)]
pub struct OpenBrowserRequest {
    pub url: String,
}

/// POST /api/open-browser
pub async fn open_in_browser(
    Json(payload): Json<OpenBrowserRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let url = payload.url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::InvalidPath(
            "Only http:// and https:// URLs can be opened".to_string(),
        ));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }

    Ok(Json(serde_json::json!({ "opened": true, "url": url })))
}
