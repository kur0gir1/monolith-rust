use axum::response::{Html, IntoResponse};
use axum::routing::{get, post};
use axum::Router;
use std::path::PathBuf;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::app_state::AppState;
use crate::error::AppError;
use crate::server::handlers::{get_media_by_id, get_media_index, get_poster, get_status, trigger_scan};
use crate::server::stream_handler::{
    get_master_playlist, get_segment, get_subtitles, get_variant_playlist, switch_audio,
};

const DEFAULT_INDEX_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MONOLITH</title>
    <style>
        :root {
            --bg-color: #000000;
            --text-color: #ffffff;
            --border-color: #ffffff;
            --font-mono: 'Courier New', Courier, monospace;
            --border-radius: 0px;
        }
        body {
            margin: 0;
            padding: 24px;
            background-color: var(--bg-color);
            color: var(--text-color);
            font-family: var(--font-mono);
        }
        .header {
            border: 2px solid var(--border-color);
            padding: 16px;
            font-size: 24px;
            font-weight: bold;
            letter-spacing: 2px;
        }
        .noise-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            pointer-events: none;
            opacity: 0.05;
            filter: url(#noiseFilter);
        }
    </style>
</head>
<body>
    <svg style="display:none;">
        <filter id="noiseFilter">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/>
        </filter>
    </svg>
    <div class="noise-overlay"></div>
    <div class="header">
        MONOLITH // OFFLINE MEDIA ENGINE
    </div>
</body>
</html>"#;

async fn index_fallback_handler() -> impl IntoResponse {
    Html(DEFAULT_INDEX_HTML)
}

/// Creates the complete Axum Router with all 10 REST endpoints, CORS, and static asset serving.
pub fn create_router(state: AppState) -> Router {
    let api_routes = Router::new()
        .route("/media", get(get_media_index))
        .route("/media/:id", get(get_media_by_id))
        .route("/media/:id/poster", get(get_poster))
        .route("/scan", post(trigger_scan))
        .route("/stream/:id/master.m3u8", get(get_master_playlist))
        .route("/stream/:id/index.m3u8", get(get_variant_playlist))
        .route("/stream/:id/:segment", get(get_segment))
        .route("/stream/:id/subtitles/:sub_index/subs.vtt", get(get_subtitles))
        .route("/stream/:id/audio", post(switch_audio))
        .route("/status", get(get_status));

    let mut frontend_dist = PathBuf::from("frontend/dist");
    if !frontend_dist.exists() {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let candidate = exe_dir.join("frontend").join("dist");
                if candidate.exists() {
                    frontend_dist = candidate;
                } else if let Some(parent_dir) = exe_dir.parent().and_then(|p| p.parent()) {
                    let workspace_candidate = parent_dir.join("frontend").join("dist");
                    if workspace_candidate.exists() {
                        frontend_dist = workspace_candidate;
                    }
                }
            }
        }
    }

    let router = Router::new()
        .nest("/api", api_routes)
        .layer(CorsLayer::permissive());

    if frontend_dist.exists() && frontend_dist.join("index.html").exists() {
        info!("Serving compiled frontend SPA from {}", frontend_dist.display());
        let serve_dir = ServeDir::new(&frontend_dist)
            .fallback(ServeFile::new(frontend_dist.join("index.html")));
        router.fallback_service(serve_dir).with_state(state)
    } else {
        info!("frontend/dist not found, mounting default Brutalist fallback UI handler");
        router
            .route("/", get(index_fallback_handler))
            .fallback(index_fallback_handler)
            .with_state(state)
    }
}

/// Spawns and runs the Axum LAN streaming server bound to the given host address (default 0.0.0.0:3000).
pub async fn start_server(state: AppState, bind_addr: &str) -> Result<(), AppError> {
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| AppError::Io(e))?;

    info!("Monolith Axum LAN server successfully bound to {}", bind_addr);

    // Spawn periodic idle transcode session reaper (every 60s, reaping sessions idle > 300s)
    let reaper_sessions = state.transcode_sessions.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            reaper_sessions
                .reap_idle_sessions(std::time::Duration::from_secs(300))
                .await;
        }
    });

    let router = create_router(state);

    axum::serve(listener, router)
        .await
        .map_err(|e| AppError::Other(format!("Axum server error: {}", e)))?;

    Ok(())
}
