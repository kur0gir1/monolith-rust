use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{watch, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TunnelProvider {
    #[serde(rename = "cloudflare")]
    Cloudflare,
    #[serde(rename = "localhost.run")]
    LocalhostRun,
    #[serde(rename = "serveo.net")]
    Serveo,
}

impl Default for TunnelProvider {
    fn default() -> Self {
        Self::Cloudflare
    }
}

impl TunnelProvider {
    pub fn from_str_opt(s: Option<&str>) -> Self {
        match s.map(|v| v.to_lowercase()).as_deref() {
            Some("localhost.run") | Some("localhost") => Self::LocalhostRun,
            Some("serveo") | Some("serveo.net") => Self::Serveo,
            _ => Self::Cloudflare,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Cloudflare => "CLOUDFLARE QUICK TUNNEL (GLOBAL EDGE)",
            Self::LocalhostRun => "LOCALHOST.RUN (SSH TLS)",
            Self::Serveo => "SERVEO.NET (SSH TLS)",
        }
    }
}

pub fn find_cloudflared_executable() -> PathBuf {
    let candidates = [
        r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
        r"C:\Program Files\cloudflared\cloudflared.exe",
    ];
    for c in candidates {
        let p = Path::new(c);
        if p.exists() {
            return p.to_path_buf();
        }
    }
    PathBuf::from("cloudflared")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStatus {
    pub active: bool,
    pub status: String, // "OFFLINE" | "CONNECTING" | "ONLINE" | "ERROR"
    pub provider: String,
    pub public_url: Option<String>,
    pub invite_token: String,
    pub invite_url: Option<String>,
    pub error: Option<String>,
}

struct TunnelInner {
    active: bool,
    status: String,
    provider: TunnelProvider,
    public_url: Option<String>,
    invite_token: String,
    error: Option<String>,
    child: Option<Child>,
    attempt_id: u64,
}

#[derive(Clone)]
pub struct TunnelManager {
    inner: Arc<RwLock<TunnelInner>>,
    status_tx: Arc<watch::Sender<u64>>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

fn generate_short_token() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn configured_public_url() -> Option<String> {
    std::env::var("MONOLITH_PUBLIC_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
}

impl TunnelManager {
    pub fn new() -> Self {
        let (status_tx, _) = watch::channel(0u64);
        Self {
            inner: Arc::new(RwLock::new(TunnelInner {
                active: false,
                status: "OFFLINE".to_string(),
                provider: TunnelProvider::Cloudflare,
                public_url: None,
                invite_token: generate_short_token(),
                error: None,
                child: None,
                attempt_id: 0,
            })),
            status_tx: Arc::new(status_tx),
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.status_tx.subscribe()
    }

    fn notify_status_change(&self) {
        self.status_tx.send_modify(|v| *v = v.wrapping_add(1));
    }

    pub async fn attempt_id(&self) -> u64 {
        self.inner.read().await.attempt_id
    }

    pub async fn get_status(&self) -> TunnelStatus {
        let guard = self.inner.read().await;
        let effective_base = configured_public_url().or_else(|| guard.public_url.clone());
        let invite_url = effective_base
            .as_ref()
            .filter(|_| guard.public_url.is_some() || configured_public_url().is_some())
            .map(|url| format!("{}/w/{}", url.trim_end_matches('/'), guard.invite_token));

        TunnelStatus {
            active: guard.active,
            status: guard.status.clone(),
            provider: guard.provider.label().to_string(),
            public_url: effective_base,
            invite_token: guard.invite_token.clone(),
            invite_url,
            error: guard.error.clone(),
        }
    }

    pub async fn verify_token(&self, candidate: Option<&str>) -> bool {
        let guard = self.inner.read().await;
        match candidate {
            Some(tok) => tok.trim() == guard.invite_token,
            None => false,
        }
    }

    pub async fn rotate_token(&self) -> TunnelStatus {
        {
            let mut guard = self.inner.write().await;
            guard.invite_token = generate_short_token();
        }
        self.get_status().await
    }

    pub async fn stop(&self) -> TunnelStatus {
        {
            let mut guard = self.inner.write().await;
            guard.attempt_id = guard.attempt_id.wrapping_add(1);
            if let Some(mut child) = guard.child.take() {
                let _ = child.start_kill();
            }
            guard.active = false;
            guard.status = "OFFLINE".to_string();
            guard.public_url = None;
            guard.error = None;
        }
        self.notify_status_change();
        self.get_status().await
    }

    pub async fn kill(&self) -> TunnelStatus {
        {
            let mut guard = self.inner.write().await;
            guard.attempt_id = guard.attempt_id.wrapping_add(1);
            if let Some(mut child) = guard.child.take() {
                let _ = child.start_kill();
            }
            guard.active = false;
            guard.status = "OFFLINE".to_string();
            guard.public_url = None;
            guard.error = None;
            // Invalidate invite token immediately so any existing link becomes invalid
            guard.invite_token = generate_short_token();
        }
        self.notify_status_change();
        self.get_status().await
    }

    pub async fn start(&self, provider: TunnelProvider, local_port: u16) -> TunnelStatus {
        // Stop any existing tunnel first
        self.stop().await;

        let my_attempt_id = {
            let mut guard = self.inner.write().await;
            guard.attempt_id = guard.attempt_id.wrapping_add(1);
            guard.provider = provider.clone();
            guard.status = "CONNECTING".to_string();
            guard.active = true;
            guard.error = None;
            guard.public_url = None;
            guard.attempt_id
        };

        let known_hosts_null = if cfg!(windows) {
            "UserKnownHostsFile=NUL"
        } else {
            "UserKnownHostsFile=/dev/null"
        };

        let mut cmd = match provider {
            TunnelProvider::LocalhostRun => {
                let mut c = Command::new("ssh");
                c.args([
                    "-o",
                    "StrictHostKeyChecking=no",
                    "-o",
                    known_hosts_null,
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ServerAliveInterval=30",
                    "-T",
                    "-R",
                    &format!("80:127.0.0.1:{}", local_port),
                    "nokey@localhost.run",
                ]);
                c
            }
            TunnelProvider::Serveo => {
                let mut c = Command::new("ssh");
                c.args([
                    "-o",
                    "StrictHostKeyChecking=no",
                    "-o",
                    known_hosts_null,
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ServerAliveInterval=30",
                    "-T",
                    "-R",
                    &format!("80:127.0.0.1:{}", local_port),
                    "serveo.net",
                ]);
                c
            }
            TunnelProvider::Cloudflare => {
                let bin = find_cloudflared_executable();
                let mut c = Command::new(bin);
                c.args([
                    "tunnel",
                    "--url",
                    &format!("http://127.0.0.1:{}", local_port),
                    "--no-autoupdate",
                ]);
                c
            }
        };

        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        match cmd.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                {
                    let mut guard = self.inner.write().await;
                    guard.child = Some(child);
                }

                if let Some(out) = stdout {
                    spawn_tunnel_output_reader(
                        out,
                        self.inner.clone(),
                        self.status_tx.clone(),
                        my_attempt_id,
                        false,
                    );
                }

                if let Some(err) = stderr {
                    spawn_tunnel_output_reader(
                        err,
                        self.inner.clone(),
                        self.status_tx.clone(),
                        my_attempt_id,
                        true,
                    );
                }
            }
            Err(e) => {
                if provider == TunnelProvider::Cloudflare {
                    warn!("cloudflared binary failed to launch ({}), auto-falling back to LOCALHOST.RUN SSH tunnel", e);
                    return Box::pin(self.start(TunnelProvider::LocalhostRun, local_port)).await;
                }
                {
                    let mut guard = self.inner.write().await;
                    guard.active = false;
                    guard.status = "ERROR".to_string();
                    guard.error = Some(format!(
                        "Failed to launch {} binary ({}). Try LOCALHOST.RUN or install cloudflared.",
                        provider.label(),
                        e
                    ));
                }
                self.notify_status_change();
            }
        }

        // Wait up to 14s so tunnel URL allocation + initial DNS propagation finish before returning
        for _ in 0..56 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let st = self.get_status().await;
            if st.public_url.is_some() || st.status == "ERROR" || !st.active {
                return st;
            }
        }

        self.get_status().await
    }
}

fn extract_url_host(url: &str) -> Option<&str> {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host_port = after_scheme.split('/').next()?;
    let host = host_port.split(':').next()?.trim();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

async fn wait_for_dns_if_quick_tunnel(
    inner: &Arc<RwLock<TunnelInner>>,
    attempt_id: u64,
    url: &str,
) -> bool {
    let Some(host) = extract_url_host(url) else {
        return true;
    };
    if !host.ends_with(".trycloudflare.com") {
        return true;
    }

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(12);
    let mut resolved = false;
    while tokio::time::Instant::now() < deadline {
        if inner.read().await.attempt_id != attempt_id {
            return false;
        }
        if let Ok(mut addrs) = tokio::net::lookup_host((host, 443)).await {
            if addrs.next().is_some() {
                resolved = true;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }

    if resolved {
        // Brief grace window after local resolver sees the record so mobile/ISP DNS catches up too
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    } else {
        warn!("Quick tunnel DNS propagation check timed out for {}; publishing anyway", host);
    }

    inner.read().await.attempt_id == attempt_id
}

fn spawn_tunnel_output_reader<R>(
    stream: R,
    inner: Arc<RwLock<TunnelInner>>,
    tx: Arc<watch::Sender<u64>>,
    attempt_id: u64,
    is_stderr: bool,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stream).lines();
        let mut published_url = false;
        while let Ok(Some(line)) = reader.next_line().await {
            if !published_url {
                if let Some(url) = extract_https_url(&line) {
                    published_url = true;
                    let inner_pub = inner.clone();
                    let tx_pub = tx.clone();
                    tokio::spawn(async move {
                        if !wait_for_dns_if_quick_tunnel(&inner_pub, attempt_id, &url).await {
                            return;
                        }
                        let mut g = inner_pub.write().await;
                        if g.attempt_id != attempt_id || g.public_url.is_some() {
                            return;
                        }
                        info!("Encrypted public tunnel established: {}", url);
                        g.public_url = Some(url);
                        g.status = "ONLINE".to_string();
                        g.error = None;
                        drop(g);
                        tx_pub.send_modify(|v| *v = v.wrapping_add(1));
                    });
                    continue;
                }
            }

            if is_stderr
                && (line.to_lowercase().contains("permission denied")
                    || line.to_lowercase().contains("connection refused"))
            {
                warn!("Tunnel stderr warning: {}", line);
                let mut g = inner.write().await;
                if g.attempt_id != attempt_id {
                    break;
                }
                if g.public_url.is_none() {
                    g.status = "ERROR".to_string();
                    g.active = false;
                    g.error = Some(line);
                    drop(g);
                    tx.send_modify(|v| *v = v.wrapping_add(1));
                }
            }
        }

        if is_stderr {
            let mut g = inner.write().await;
            if g.attempt_id == attempt_id
                && (g.status == "CONNECTING" || g.status == "ONLINE")
            {
                let was_online = g.status == "ONLINE";
                g.status = "ERROR".to_string();
                g.active = false;
                g.public_url = None;
                if g.error.is_none() {
                    g.error = Some(if was_online {
                        "Tunnel process exited unexpectedly.".to_string()
                    } else {
                        "Tunnel process exited before establishing a public URL.".to_string()
                    });
                }
                drop(g);
                tx.send_modify(|v| *v = v.wrapping_add(1));
            }
        }
    });
}

fn extract_https_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| {
            c == ','
                || c == ';'
                || c == '('
                || c == ')'
                || c == '['
                || c == ']'
                || c == '"'
                || c == '\''
                || c == '|'
        });
        if cleaned.starts_with("https://") {
            // Exclude documentation / admin links printed in banner messages
            if cleaned.contains("localhost.run")
                || cleaned.contains("cloudflare.com/website-terms")
                || cleaned.contains("admin.localhost.run")
            {
                continue;
            }
            if cleaned.contains(".lhr.life")
                || cleaned.contains(".trycloudflare.com")
                || cleaned.contains(".serveo.net")
                || cleaned.contains(".serveousercontent.com")
            {
                return Some(cleaned.trim_end_matches('/').to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_tunnel_kill_invalidates_token() {
        let mgr = TunnelManager::new();
        let initial_token = mgr.get_status().await.invite_token;
        let killed = mgr.kill().await;
        assert!(!killed.active);
        assert_eq!(killed.status, "OFFLINE");
        assert_ne!(killed.invite_token, initial_token);
        assert!(!mgr.verify_token(Some(&initial_token)).await);
        assert!(mgr.verify_token(Some(&killed.invite_token)).await);
    }

    #[tokio::test]
    async fn test_tunnel_attempt_id_and_subscribe_on_stop_kill() {
        let mgr = TunnelManager::new();
        let mut rx = mgr.subscribe();
        let id0 = mgr.attempt_id().await;

        mgr.stop().await;
        assert!(rx.has_changed().unwrap_or(false));
        let _ = rx.borrow_and_update();
        let id1 = mgr.attempt_id().await;
        assert!(id1 > id0);

        mgr.kill().await;
        assert!(rx.has_changed().unwrap_or(false));
        let id2 = mgr.attempt_id().await;
        assert!(id2 > id1);
    }

    #[test]
    fn test_extract_cloudflare_url() {
        let line = "2026-11-10T14:00:00Z INF +--------------------------------------------------------------------------------------------+";
        let line2 = "2026-11-10T14:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |";
        let line3 = "2026-11-10T14:00:00Z INF |  https://temporary-subdomain.trycloudflare.com                                         |";
        assert_eq!(extract_https_url(line), None);
        assert_eq!(extract_https_url(line2), None);
        assert_eq!(
            extract_https_url(line3),
            Some("https://temporary-subdomain.trycloudflare.com".to_string())
        );
        assert_eq!(
            extract_url_host("https://temporary-subdomain.trycloudflare.com/w/123"),
            Some("temporary-subdomain.trycloudflare.com")
        );
    }
}
