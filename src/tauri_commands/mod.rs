use tauri::State;
use std::path::Path;
use crate::app_state::AppState;
use crate::error::AppError;
use crate::metadata::probe_media_file;
use crate::models::MediaItem;
use crate::poster::extract_or_get_poster;
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

/// Recursively scans the provided directory path, enriches metadata/posters, updates AppState, and returns items.
#[tauri::command]
pub async fn scan_directory(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<MediaItem>, AppError> {
    let items = tokio::task::spawn_blocking({
        let path = path.clone();
        move || -> Result<Vec<MediaItem>, AppError> {
            let mut scanned = run_scan(&path)?;
            for item in &mut scanned {
                let p = Path::new(&item.file_path);
                if let Ok(meta) = probe_media_file(p) {
                    item.metadata = Some(meta);
                }
                if let Ok(poster) = extract_or_get_poster(p, &item.id) {
                    item.poster_path = Some(poster.to_string_lossy().to_string());
                }
            }
            Ok(scanned)
        }
    })
    .await
    .map_err(|e| AppError::JoinError(e.to_string()))??;

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
