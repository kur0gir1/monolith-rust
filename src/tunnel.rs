use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TunnelProvider {
    #[serde(rename = "localhost.run")]
    LocalhostRun,
    #[serde(rename = "serveo.net")]
    Serveo,
    #[serde(rename = "cloudflare")]
    Cloudflare,
}

impl Default for TunnelProvider {
    fn default() -> Self {
        Self::LocalhostRun
    }
}

impl TunnelProvider {
    pub fn from_str_opt(s: Option<&str>) -> Self {
        match s.map(|v| v.to_lowercase()).as_deref() {
            Some("cloudflare") | Some("cloudflared") => Self::Cloudflare,
            Some("serveo") | Some("serveo.net") => Self::Serveo,
            _ => Self::LocalhostRun,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::LocalhostRun => "LOCALHOST.RUN (SSH TLS)",
            Self::Serveo => "SERVEO.NET (SSH TLS)",
            Self::Cloudflare => "CLOUDFLARE QUICK TUNNEL",
        }
    }
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
}

#[derive(Clone)]
pub struct TunnelManager {
    inner: Arc<RwLock<TunnelInner>>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(TunnelInner {
                active: false,
                status: "OFFLINE".to_string(),
                provider: TunnelProvider::LocalhostRun,
                public_url: None,
                invite_token: Uuid::new_v4().simple().to_string(),
                error: None,
                child: None,
            })),
        }
    }

    pub async fn get_status(&self) -> TunnelStatus {
        let guard = self.inner.read().await;
        let invite_url = guard
            .public_url
            .as_ref()
            .map(|url| format!("{}/?invite={}", url.trim_end_matches('/'), guard.invite_token));

        TunnelStatus {
            active: guard.active,
            status: guard.status.clone(),
            provider: guard.provider.label().to_string(),
            public_url: guard.public_url.clone(),
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
            guard.invite_token = Uuid::new_v4().simple().to_string();
        }
        self.get_status().await
    }

    pub async fn stop(&self) -> TunnelStatus {
        {
            let mut guard = self.inner.write().await;
            if let Some(mut child) = guard.child.take() {
                let _ = child.start_kill();
            }
            guard.active = false;
            guard.status = "OFFLINE".to_string();
            guard.public_url = None;
            guard.error = None;
        }
        self.get_status().await
    }

    pub async fn start(&self, provider: TunnelProvider, local_port: u16) -> TunnelStatus {
        // Stop any existing tunnel first
        self.stop().await;

        {
            let mut guard = self.inner.write().await;
            guard.provider = provider.clone();
            guard.status = "CONNECTING".to_string();
            guard.active = true;
            guard.error = None;
            guard.public_url = None;
        }

        let mut cmd = match provider {
            TunnelProvider::LocalhostRun => {
                let mut c = Command::new("ssh");
                c.args([
                    "-o",
                    "StrictHostKeyChecking=no",
                    "-o",
                    "UserKnownHostsFile=NUL",
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
                    "UserKnownHostsFile=NUL",
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
                let mut c = Command::new("cloudflared");
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
                    let inner_clone = self.inner.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(out).lines();
                        while let Ok(Some(line)) = reader.next_line().await {
                            if let Some(url) = extract_https_url(&line) {
                                info!("Encrypted public tunnel established: {}", url);
                                let mut g = inner_clone.write().await;
                                g.public_url = Some(url);
                                g.status = "ONLINE".to_string();
                                g.error = None;
                            }
                        }
                    });
                }

                if let Some(err) = stderr {
                    let inner_clone = self.inner.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(err).lines();
                        while let Ok(Some(line)) = reader.next_line().await {
                            if let Some(url) = extract_https_url(&line) {
                                info!("Encrypted public tunnel established (stderr): {}", url);
                                let mut g = inner_clone.write().await;
                                g.public_url = Some(url);
                                g.status = "ONLINE".to_string();
                                g.error = None;
                            } else if line.to_lowercase().contains("permission denied")
                                || line.to_lowercase().contains("connection refused")
                            {
                                warn!("Tunnel stderr warning: {}", line);
                                let mut g = inner_clone.write().await;
                                if g.public_url.is_none() {
                                    g.status = "ERROR".to_string();
                                    g.active = false;
                                    g.error = Some(line);
                                }
                            }
                        }
                    });
                }
            }
            Err(e) => {
                let mut guard = self.inner.write().await;
                guard.active = false;
                guard.status = "ERROR".to_string();
                guard.error = Some(format!(
                    "Failed to launch {} binary ({}). Try LOCALHOST.RUN or install cloudflared.",
                    provider.label(),
                    e
                ));
            }
        }

        // Wait up to 4.5s for the tunnel URL to appear so the caller gets it immediately if fast
        for _ in 0..18 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let st = self.get_status().await;
            if st.public_url.is_some() || st.status == "ERROR" || !st.active {
                return st;
            }
        }

        self.get_status().await
    }
}

fn extract_https_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| {
            c == ',' || c == ';' || c == '(' || c == ')' || c == '[' || c == ']' || c == '"' || c == '\''
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
