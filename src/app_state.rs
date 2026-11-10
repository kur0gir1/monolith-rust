use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::models::MediaItem;
use crate::transcoder::SessionManager;

#[derive(Clone, Default)]
pub struct AppState {
    pub catalog: Arc<RwLock<HashMap<String, MediaItem>>>,
    pub selected_directory: Arc<RwLock<Option<String>>>,
    pub transcode_sessions: SessionManager,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            catalog: Arc::new(RwLock::new(HashMap::new())),
            selected_directory: Arc::new(RwLock::new(None)),
            transcode_sessions: SessionManager::new(),
        }
    }

    /// Replaces the catalog with a new collection of items.
    pub async fn set_items(&self, items: Vec<MediaItem>) {
        let mut map = self.catalog.write().await;
        map.clear();
        for item in items {
            map.insert(item.id.clone(), item);
        }
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

    /// Sets the currently selected directory.
    pub async fn set_selected_directory(&self, path: Option<String>) {
        let mut dir = self.selected_directory.write().await;
        *dir = path;
    }

    /// Gets the currently selected directory.
    pub async fn get_selected_directory(&self) -> Option<String> {
        let dir = self.selected_directory.read().await;
        dir.clone()
    }
}
