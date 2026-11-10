use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::models::MediaItem;
use crate::transcoder::SessionManager;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedLibraryState {
    pub selected_directory: Option<String>,
    pub items: Vec<MediaItem>,
}

/// Returns the path to `%LOCALAPPDATA%\Monolith\library_state.json`.
pub fn get_state_file_path() -> PathBuf {
    if let Some(local_app_data) = dirs::data_local_dir() {
        local_app_data.join("Monolith").join("library_state.json")
    } else {
        std::env::temp_dir().join("Monolith").join("library_state.json")
    }
}

#[derive(Clone, Default)]
pub struct AppState {
    pub catalog: Arc<RwLock<HashMap<String, MediaItem>>>,
    pub selected_directory: Arc<RwLock<Option<String>>>,
    pub transcode_sessions: SessionManager,
}

impl AppState {
    /// Creates a new in-memory AppState (used by unit/integration tests).
    pub fn new() -> Self {
        Self {
            catalog: Arc::new(RwLock::new(HashMap::new())),
            selected_directory: Arc::new(RwLock::new(None)),
            transcode_sessions: SessionManager::new(),
        }
    }

    /// Loads persisted root directory and media catalog from `%LOCALAPPDATA%\Monolith\library_state.json`.
    pub fn new_with_persistence() -> Self {
        let state_path = get_state_file_path();
        if state_path.exists() {
            if let Ok(content) = fs::read_to_string(&state_path) {
                if let Ok(persisted) = serde_json::from_str::<PersistedLibraryState>(&content) {
                    let mut map = HashMap::with_capacity(persisted.items.len());
                    for item in persisted.items {
                        if std::path::Path::new(&item.file_path).exists() {
                            map.insert(item.id.clone(), item);
                        }
                    }
                    info!(
                        "Restored persisted library state: root={:?}, items={}",
                        persisted.selected_directory,
                        map.len()
                    );
                    return Self {
                        catalog: Arc::new(RwLock::new(map)),
                        selected_directory: Arc::new(RwLock::new(persisted.selected_directory)),
                        transcode_sessions: SessionManager::new(),
                    };
                }
            }
        }
        Self::new()
    }

    /// Saves the current root directory and catalog to `%LOCALAPPDATA%\Monolith\library_state.json`.
    pub async fn save_to_disk(&self) {
        let selected_directory = self.get_selected_directory().await;
        let items = self.get_all_items().await;
        let persisted = PersistedLibraryState {
            selected_directory,
            items,
        };
        let state_path = get_state_file_path();
        let _ = tokio::task::spawn_blocking(move || {
            if let Some(parent) = state_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&persisted) {
                if let Err(e) = fs::write(&state_path, json) {
                    warn!("Failed to persist library state to {}: {}", state_path.display(), e);
                }
            }
        })
        .await;
    }

    /// Replaces the catalog with a new collection of items and persists to disk.
    pub async fn set_items(&self, items: Vec<MediaItem>) {
        {
            let mut map = self.catalog.write().await;
            map.clear();
            for item in items {
                map.insert(item.id.clone(), item);
            }
        }
        self.save_to_disk().await;
    }

    /// Upserts a single item in the catalog.
    pub async fn upsert_item(&self, item: MediaItem) {
        let mut map = self.catalog.write().await;
        map.insert(item.id.clone(), item);
    }

    /// Retrieves all items as a vector sorted by file_name.
    pub async fn get_all_items(&self) -> Vec<MediaItem> {
        let map = self.catalog.read().await;
        let mut items: Vec<MediaItem> = map.values().cloned().collect();
        items.sort_by(|a, b| a.file_name.cmp(&b.file_name));
        items
    }

    /// Retrieves an item by its ID.
    pub async fn get_item(&self, id: &str) -> Option<MediaItem> {
        let map = self.catalog.read().await;
        map.get(id).cloned()
    }

    /// Returns the total count of indexed media items.
    pub async fn count(&self) -> usize {
        let map = self.catalog.read().await;
        map.len()
    }

    /// Sets the currently selected directory and persists to disk.
    pub async fn set_selected_directory(&self, path: Option<String>) {
        {
            let mut dir = self.selected_directory.write().await;
            *dir = path;
        }
        self.save_to_disk().await;
    }

    /// Gets the currently selected directory.
    pub async fn get_selected_directory(&self) -> Option<String> {
        let dir = self.selected_directory.read().await;
        dir.clone()
    }
}
