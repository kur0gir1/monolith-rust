use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use std::path::PathBuf;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::app_state::AppState;
use crate::error::AppError;
use crate::server::handlers::{
    get_media_by_id, get_media_chapters, get_media_index, get_party_state, get_poster, get_status,
    get_tunnel_status,
    kill_tunnel, leave_party, open_in_browser, reset_party, rotate_tunnel_token, start_tunnel,
    stop_tunnel, trigger_scan, update_party_state,
};
use crate::server::stream_handler::{
    get_master_playlist, get_quality_scoped_segment, get_quality_variant_playlist,
    get_scoped_segment, get_scoped_variant_playlist, get_segment, get_subtitles,
    get_variant_playlist, switch_audio,
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

fn is_public_tunnel_host(req: &Request) -> bool {
    if req.headers().contains_key("x-forwarded-for") {
        return true;
    }
    if let Some(host) = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()) {
        let h = host.to_lowercase();
        if h.contains(".lhr.life")
            || h.contains(".trycloudflare.com")
            || h.contains(".serveo.net")
            || h.contains(".serveousercontent.com")
        {
            return true;
        }
        if let Ok(pub_url) = std::env::var("MONOLITH_PUBLIC_URL") {
            let pub_host = pub_url
                .trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or("")
                .to_lowercase();
            if !pub_host.is_empty() && (h == pub_host || h.starts_with(&format!("{pub_host}:"))) {
                return true;
            }
        }
    }
    false
}

fn extract_invite_token_from_path(path: &str) -> Option<String> {
    for prefix in ["/w/", "/tv/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            let tok = rest.split('/').next().unwrap_or("").trim();
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    None
}

fn extract_invite_token_from_req(req: &Request) -> Option<String> {
    // 1. Check query string `?invite=TOKEN`
    if let Some(q) = req.uri().query() {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "invite" && !v.trim().is_empty() {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    // 2. Check clean invite path `/w/TOKEN` or `/tv/TOKEN`
    if let Some(tok) = extract_invite_token_from_path(req.uri().path()) {
        return Some(tok);
    }
    // 3. Check custom header `x-monolith-invite`
    if let Some(hdr) = req
        .headers()
        .get("x-monolith-invite")
        .and_then(|v| v.to_str().ok())
    {
        if !hdr.trim().is_empty() {
            return Some(hdr.trim().to_string());
        }
    }
    // 4. Check Cookie `monolith_invite=TOKEN`
    if let Some(cookies) = req.headers().get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        for part in cookies.split(';') {
            if let Some((k, v)) = part.trim().split_once('=') {
                if k.trim() == "monolith_invite" && !v.trim().is_empty() {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

async fn invite_auth_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    if !is_public_tunnel_host(&req) {
        return next.run(req).await;
    }

    let path = req.uri().path().to_string();

    // Never allow remote tunnel clients to mutate host directory or tunnel settings
    if path.starts_with("/api/scan")
        || path.starts_with("/api/tunnel")
        || path.starts_with("/api/open-browser")
    {
        return (
            StatusCode::FORBIDDEN,
            "Host administration endpoints are locked for remote tunnel guests",
        )
            .into_response();
    }

    let token_candidate = extract_invite_token_from_req(&req);
    if path.starts_with("/api/") {
        if !state.tunnel.verify_token(token_candidate.as_deref()).await {
            return (
                StatusCode::UNAUTHORIZED,
                "Valid encrypted invite token required (?invite=...)",
            )
                .into_response();
        }
    }

    let mut resp = next.run(req).await;
    if let Some(tok) = token_candidate {
        if state.tunnel.verify_token(Some(&tok)).await {
            if let Ok(cookie_val) = header::HeaderValue::from_str(&format!(
                "monolith_invite={}; Path=/; Max-Age=86400; SameSite=Lax; Secure",
                tok
            )) {
                resp.headers_mut().insert(header::SET_COOKIE, cookie_val);
            }
        }
    }
    resp
}

/// Creates the complete Axum Router with REST endpoints, tunnel & party sync, CORS, and static asset serving.
pub fn create_router(state: AppState) -> Router {
    let api_routes = Router::new()
        .route("/media", get(get_media_index))
        .route("/media/:id", get(get_media_by_id))
        .route("/media/:id/chapters", get(get_media_chapters))
        .route("/media/:id/poster", get(get_poster))
        .route("/scan", post(trigger_scan))
        .route("/stream/:id/master.m3u8", get(get_master_playlist))
        .route(
            "/stream/:id/v/:max_w/:audio/:start/index.m3u8",
            get(get_quality_variant_playlist),
        )
        .route(
            "/stream/:id/v/:max_w/:audio/:start/:segment",
            get(get_quality_scoped_segment),
        )
        .route(
            "/stream/:id/s/:audio/:start/index.m3u8",
            get(get_scoped_variant_playlist),
        )
        .route(
            "/stream/:id/s/:audio/:start/:segment",
            get(get_scoped_segment),
        )
        .route("/stream/:id/index.m3u8", get(get_variant_playlist))
        .route("/stream/:id/:segment", get(get_segment))
        .route("/stream/:id/subtitles/:sub_index/subs.vtt", get(get_subtitles))
        .route("/stream/:id/audio", post(switch_audio))
        .route("/status", get(get_status))
        .route("/tunnel", get(get_tunnel_status))
        .route("/tunnel/start", post(start_tunnel))
        .route("/tunnel/stop", post(stop_tunnel))
        .route("/tunnel/kill", post(kill_tunnel))
        .route("/tunnel/rotate", post(rotate_tunnel_token))
        .route("/party", get(get_party_state).post(update_party_state))
        .route("/party/leave", post(leave_party))
        .route("/party/reset", post(reset_party))
        .route("/open-browser", post(open_in_browser));

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
        .layer(middleware::from_fn_with_state(
            state.clone(),
            invite_auth_middleware,
        ))
        .layer(CorsLayer::permissive())
        .layer(CompressionLayer::new());

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_short_invite_path() {
        assert_eq!(
            extract_invite_token_from_path("/w/abc123def456"),
            Some("abc123def456".to_string())
        );
        assert_eq!(
            extract_invite_token_from_path("/tv/room99/"),
            Some("room99".to_string())
        );
        assert_eq!(extract_invite_token_from_path("/api/media"), None);
    }
}
