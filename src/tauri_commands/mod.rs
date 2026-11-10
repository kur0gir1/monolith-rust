use tauri::State;
use std::path::Path;
use crate::app_state::AppState;
use crate::error::AppError;
use crate::metadata::probe_media_file;
use crate::models::MediaItem;
use crate::poster::get_cached_poster_path;
use crate::scanner::scan_directory as run_scan;

/// Opens the native Windows folder picker dialog asynchronously on a blocking thread.
#[tauri::command]
pub async fn pick_directory() -> Result<Option<String>, AppError> {
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Select Media Folder")
            .pick_folder()
    })
    .await
    .map_err(|e| AppError::JoinError(e.to_string()))?;

    Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

/// Recursively scans the provided directory path, enriches metadata in parallel, updates AppState, and returns items.
#[tauri::command]
pub async fn scan_directory(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<MediaItem>, AppError> {
    let scanned = tokio::task::spawn_blocking({
        let path = path.clone();
        move || run_scan(&path)
    })
    .await
    .map_err(|e| AppError::JoinError(e.to_string()))??;

    // Probe metadata concurrently across a bounded worker pool (up to 8 parallel ffprobe calls);
    // Posters are extracted lazily on-demand by `/api/media/:id/poster` so scanning returns much faster.
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
    let mut handles = Vec::with_capacity(scanned.len());
    for mut item in scanned {
        let sem_clone = sem.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem_clone.acquire().await.ok();
            tokio::task::spawn_blocking(move || {
                let p = Path::new(&item.file_path);
                if let Ok(meta) = probe_media_file(p) {
                    item.metadata = Some(meta);
                }
                let cached = get_cached_poster_path(&item.id);
                if cached.exists() {
                    item.poster_path = Some(cached.to_string_lossy().to_string());
                }
                item
            })
            .await
            .unwrap_or_else(|_| panic!("probe task panicked"))
        }));
    }

    let mut items = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(item) = h.await {
            items.push(item);
        }
    }

    state.set_items(items.clone()).await;
    state.set_selected_directory(Some(path)).await;

    Ok(items)
}

/// Helper command: Opens folder picker if path is None, scans, updates AppState, and returns items.
#[tauri::command]
pub async fn select_and_scan_directory(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MediaItem>, AppError> {
    let target_path = match path {
        Some(p) => p,
        None => match pick_directory().await? {
            Some(p) => p,
            None => return Ok(Vec::new()), // User canceled folder selection
        },
    };

    scan_directory(target_path, state).await
}

/// Retrieves all indexed media items from AppState.
#[tauri::command]
pub async fn get_media_items(
    state: State<'_, AppState>,
) -> Result<Vec<MediaItem>, AppError> {
    Ok(state.get_all_items().await)
}

/// Retrieves a single media item by ID from AppState.
#[tauri::command]
pub async fn get_media_item(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<MediaItem>, AppError> {
    Ok(state.get_item(&id).await)
}

/// Retrieves the currently selected folder path.
#[tauri::command]
pub async fn get_selected_directory(
    state: State<'_, AppState>,
) -> Result<Option<String>, AppError> {
    Ok(state.get_selected_directory().await)
}
