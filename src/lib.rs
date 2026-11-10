pub mod app_state;
pub mod error;
pub mod metadata;
pub mod models;
pub mod poster;
pub mod scanner;
pub mod server;
pub mod tauri_commands;
pub mod transcoder;

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

    let app_state = AppState::new();

    tauri::Builder::default()
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
                tracing::info!("Spawning Axum LAN streaming server on 0.0.0.0:3000...");
                if let Err(e) = server::start_server(server_state, "0.0.0.0:3000").await {
                    tracing::error!("Axum server runtime error: {}", e);
                }
            });

            tracing::info!("Monolith Tauri v2 host setup complete");
            Ok(())
        })
        .run(tauri::generate_context!("src-tauri/tauri.conf.json"))
        .expect("error while running Monolith desktop host");
}
