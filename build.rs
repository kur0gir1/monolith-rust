fn main() {
    let attributes = tauri_build::Attributes::new()
        .config_path("src-tauri/tauri.conf.json")
        .capabilities_path_pattern("src-tauri/capabilities/**/*.json");
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
