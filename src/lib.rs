pub mod app_state;
pub mod error;
pub mod metadata;
pub mod models;
pub mod party;
pub mod poster;
pub mod scanner;
pub mod server;
pub mod tauri_commands;
pub mod transcoder;
pub mod tunnel;

use app_state::AppState;
use tauri::Manager;
use tauri_commands::{
    get_media_item, get_media_items, get_selected_directory, pick_directory, scan_directory,
    select_and_scan_directory,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();
    tracing::info!("Initializing Monolith Desktop Host...");

    let app_state = AppState::new_with_persistence();
    let exit_state = app_state.clone();

    let app = tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            scan_directory,
            select_and_scan_directory,
            get_media_items,
            get_media_item,
            get_selected_directory
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app_handle.state::<AppState>().inner().clone();

            let server_state = state.clone();
            tauri::async_runtime::spawn(async move {
                tracing::info!("Spawning Axum LAN streaming server on 0.0.0.0:9000...");
                if let Err(e) = server::start_server(server_state, "0.0.0.0:9000").await {
                    tracing::error!("Axum server runtime error: {}", e);
                }
            });

            // Background增量 refresh if a root directory was restored from disk
            let refresh_state = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(saved_dir) = refresh_state.get_selected_directory().await {
                    let path_buf = std::path::PathBuf::from(&saved_dir);
                    if path_buf.exists() {
                        tracing::info!("Background-syncing persisted root directory: {}", saved_dir);
                        let existing_items = refresh_state.get_all_items().await;
                        let mut existing_by_id = std::collections::HashMap::new();
                        for it in existing_items {
                            existing_by_id.insert(it.id.clone(), it);
                        }

                        if let Ok(Ok(scanned)) = tokio::task::spawn_blocking(move || {
                            crate::scanner::scan_directory(&path_buf)
                        })
                        .await
                        {
                            let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(6));
                            let mut handles = Vec::with_capacity(scanned.len());
                            for mut item in scanned {
                                if let Some(prev) = existing_by_id.get(&item.id) {
                                    if prev.metadata.is_some() {
                                        item.metadata = prev.metadata.clone();
                                        item.poster_path = prev.poster_path.clone();
                                        handles.push(tokio::spawn(async move { item }));
                                        continue;
                                    }
                                }
                                let sem_c = sem.clone();
                                handles.push(tokio::spawn(async move {
                                    let _p = sem_c.acquire().await.ok();
                                    tokio::task::spawn_blocking(move || {
                                        let p = std::path::Path::new(&item.file_path);
                                        if let Ok(meta) = crate::metadata::probe_media_file(p) {
                                            item.metadata = Some(meta);
                                        }
                                        let cached = crate::poster::get_cached_poster_path(&item.id);
                                        if cached.exists() {
                                            item.poster_path = Some(cached.to_string_lossy().to_string());
                                        }
                                        item
                                    })
                                    .await
                                    .unwrap_or_else(|_| panic!("bg probe failed"))
                                }));
                            }
                            let mut merged = Vec::with_capacity(handles.len());
                            for h in handles {
                                if let Ok(it) = h.await {
                                    merged.push(it);
                                }
                            }
                            refresh_state.set_items(merged).await;
                        }
                    }
                }
            });

            tracing::info!("Monolith Tauri v2 host setup complete");
            Ok(())
        })
        .build(tauri::generate_context!("src-tauri/tauri.conf.json"))
        .expect("error while building Monolith desktop host");

    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = exit_state.clone();
            tauri::async_runtime::block_on(async move {
                state.transcode_sessions.shutdown_all().await;
                let _ = state.tunnel.stop().await;
            });
        }
    });
}
