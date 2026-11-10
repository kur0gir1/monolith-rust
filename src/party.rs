use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartyState {
    pub enabled: bool,
    pub media_id: Option<String>,
    pub media_title: Option<String>,
    pub is_playing: bool,
    pub current_time: f64,
    pub audio_track: usize,
    pub subtitle_track: Option<usize>,
    pub updated_at_ms: u64,
    pub event_seq: u64,
    pub updated_by: String,
    pub active_peers: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PartyUpdateRequest {
    pub peer_id: String,
    pub enabled: Option<bool>,
    pub media_id: Option<String>,
    pub media_title: Option<String>,
    pub is_playing: Option<bool>,
    pub current_time: Option<f64>,
    pub audio_track: Option<usize>,
    pub subtitle_track: Option<Option<usize>>,
}

struct PartyInner {
    state: PartyState,
    peers: HashMap<String, u64>,
}

#[derive(Clone)]
pub struct PartyManager {
    inner: Arc<RwLock<PartyInner>>,
}

impl Default for PartyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PartyManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(PartyInner {
                state: PartyState {
                    enabled: true,
                    media_id: None,
                    media_title: None,
                    is_playing: false,
                    current_time: 0.0,
                    audio_track: 0,
                    subtitle_track: None,
                    updated_at_ms: now_ms(),
                    event_seq: 0,
                    updated_by: "system".to_string(),
                    active_peers: 0,
                },
                peers: HashMap::new(),
            })),
        }
    }

    pub async fn get_state(&self, peer_id: Option<&str>) -> PartyState {
        let now = now_ms();
        let mut guard = self.inner.write().await;

        if let Some(pid) = peer_id {
            if !pid.trim().is_empty() {
                guard.peers.insert(pid.to_string(), now);
            }
        }

        // Prune peers silent for > 15s
        guard.peers.retain(|_, last_seen| now.saturating_sub(*last_seen) <= 15_000);
        guard.state.active_peers = guard.peers.len().max(1);

        let mut snapshot = guard.state.clone();
        if snapshot.is_playing && snapshot.media_id.is_some() {
            let elapsed_secs = now.saturating_sub(snapshot.updated_at_ms) as f64 / 1000.0;
            snapshot.current_time += elapsed_secs;
        }
        snapshot
    }

    pub async fn update(&self, req: PartyUpdateRequest) -> PartyState {
        let now = now_ms();
        let mut guard = self.inner.write().await;

        if !req.peer_id.trim().is_empty() {
            guard.peers.insert(req.peer_id.clone(), now);
        }
        guard.peers.retain(|_, last_seen| now.saturating_sub(*last_seen) <= 15_000);

        if let Some(en) = req.enabled {
            guard.state.enabled = en;
        }
        if let Some(mid) = req.media_id {
            if mid.is_empty() {
                guard.state.media_id = None;
                guard.state.media_title = None;
                guard.state.is_playing = false;
                guard.state.current_time = 0.0;
            } else {
                guard.state.media_id = Some(mid);
            }
        }
        if let Some(title) = req.media_title {
            guard.state.media_title = if title.is_empty() { None } else { Some(title) };
        }
        if let Some(playing) = req.is_playing {
            guard.state.is_playing = playing;
        }
        if let Some(time) = req.current_time {
            if time.is_finite() && time >= 0.0 {
                guard.state.current_time = time;
            }
        }
        if let Some(audio) = req.audio_track {
            guard.state.audio_track = audio;
        }
        if let Some(sub) = req.subtitle_track {
            guard.state.subtitle_track = sub;
        }

        guard.state.updated_at_ms = now;
        guard.state.event_seq += 1;
        guard.state.updated_by = req.peer_id;
        guard.state.active_peers = guard.peers.len().max(1);

        guard.state.clone()
    }

    pub async fn remove_peer(&self, peer_id: &str) -> PartyState {
        let mut guard = self.inner.write().await;
        guard.peers.remove(peer_id);
        guard.state.active_peers = guard.peers.len().max(1);
        guard.state.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_peer_registration_and_removal() {
        let mgr = PartyManager::new();
        let st1 = mgr.get_state(Some("peer-alpha")).await;
        assert_eq!(st1.active_peers, 1);

        let st2 = mgr.get_state(Some("peer-beta")).await;
        assert_eq!(st2.active_peers, 2);

        let st3 = mgr.remove_peer("peer-alpha").await;
        assert_eq!(st3.active_peers, 1);
    }
}
