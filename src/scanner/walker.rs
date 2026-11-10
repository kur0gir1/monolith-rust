use std::collections::{HashSet, VecDeque};
use std::fs::{self, DirEntry};
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

use crate::error::AppError;
use crate::models::MediaItem;

/// Supported video file extensions in lowercase.
pub const SUPPORTED_EXTENSIONS: &[&str] = &["mkv", "mp4", "webm", "avi"];

/// Options for configuring the directory scanner.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// Maximum directory traversal depth (None for unlimited).
    pub max_depth: Option<usize>,
    /// Whether to follow directory symlinks and junctions with cycle detection.
    pub follow_symlinks: bool,
    /// Case-insensitive extensions to match (defaults to SUPPORTED_EXTENSIONS).
    pub extensions: Vec<String>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_depth: None,
            follow_symlinks: true,
            extensions: SUPPORTED_EXTENSIONS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

/// Checks if a file path has one of the supported video extensions (case-insensitive).
/// Returns Some(extension_lowercase) if matched, None otherwise.
pub fn is_supported_video_file(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?;
    let ext_lower = ext.to_ascii_lowercase();
    if SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str()) {
        Some(ext_lower)
    } else {
        None
    }
}

/// Normalizes path to Windows extended-length prefix (`\\?\`) if appropriate.
pub fn normalize_for_windows_long_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::Component;
        let path_str = path.to_string_lossy();
        if path_str.starts_with(r"\\?\") || path_str.starts_with(r"\??\") {
            return path.to_path_buf();
        }
        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            if let Some(Component::RootDir) = components.next() {
                let rest: PathBuf = components.collect();
                let drive = prefix.as_os_str().to_string_lossy();
                let verbatim = format!(r"\\?\{}\{}", drive, rest.display());
                return PathBuf::from(verbatim);
            }
        }
    }
    path.to_path_buf()
}

/// Simplifies verbatim Windows UNC path for user-facing serialization and display.
pub fn clean_path_display(path: &Path) -> String {
    let s = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            if !stripped.starts_with(r"UNC\") {
                return stripped.to_string();
            }
        }
    }
    s.to_string()
}

/// Generates a deterministic ID for a media item based on its path and size.
pub fn generate_deterministic_id(file_path: &str, file_size: u64) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(file_path.as_bytes());
    hasher.update(file_size.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

/// Scans a directory recursively with default options.
pub fn scan_directory<P: AsRef<Path>>(root_path: P) -> Result<Vec<MediaItem>, AppError> {
    scan_directory_with_options(root_path.as_ref(), &ScanOptions::default())
}

/// Scans a directory recursively with customized options.
pub fn scan_directory_with_options(
    root_path: &Path,
    options: &ScanOptions,
) -> Result<Vec<MediaItem>, AppError> {
    if !root_path.exists() {
        return Err(AppError::NotFound(format!(
            "Directory does not exist: {}",
            root_path.display()
        )));
    }

    if !root_path.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Specified path is not a directory: {}",
            root_path.display()
        )));
    }

    let root_path_abs = if root_path.is_relative() {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(root_path),
            Err(_) => root_path.to_path_buf(),
        }
    } else {
        root_path.to_path_buf()
    };

    info!("Starting directory scan at: {}", root_path_abs.display());

    let mut media_items = Vec::new();
    let mut visited_canonical_paths: HashSet<PathBuf> = HashSet::new();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();

    // Canonicalize root to initialize visited set for cycle detection
    let canonical_root = match fs::canonicalize(&root_path_abs) {
        Ok(c) => c,
        Err(err) => {
            warn!(
                "Could not canonicalize root path {}: {}. Proceeding with normalized path.",
                root_path_abs.display(),
                err
            );
            normalize_for_windows_long_path(&root_path_abs)
        }
    };
    visited_canonical_paths.insert(canonical_root);

    queue.push_back((root_path_abs, 0));

    while let Some((current_dir, current_depth)) = queue.pop_front() {
        if let Some(max_depth) = options.max_depth {
            if current_depth > max_depth {
                continue;
            }
        }

        debug!(
            "Scanning directory at depth {}: {}",
            current_depth,
            current_dir.display()
        );

        let scan_target = normalize_for_windows_long_path(&current_dir);
        let entries = match fs::read_dir(&scan_target) {
            Ok(iter) => iter,
            Err(err) => {
                warn!(
                    "Permission denied or I/O error reading directory {}: {}. Skipping.",
                    current_dir.display(),
                    err
                );
                continue;
            }
        };

        for entry_result in entries {
            let entry: DirEntry = match entry_result {
                Ok(e) => e,
                Err(err) => {
                    warn!(
                        "Failed to read directory entry in {}: {}. Continuing.",
                        current_dir.display(),
                        err
                    );
                    continue;
                }
            };

            let entry_path = entry.path();
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(err) => {
                    warn!(
                        "Could not determine file type for {}: {}. Skipping.",
                        entry_path.display(),
                        err
                    );
                    continue;
                }
            };

            if file_type.is_dir() || (file_type.is_symlink() && options.follow_symlinks) {
                // Resolve canonical path for cycle detection on symlinks and Windows NTFS directory junctions
                if file_type.is_symlink() {
                    let canonical = match fs::canonicalize(&entry_path) {
                        Ok(c) => c,
                        Err(err) => {
                            warn!(
                                "Broken symlink or inaccessible junction at {}: {}. Skipping.",
                                entry_path.display(),
                                err
                            );
                            continue;
                        }
                    };

                    if !canonical.is_dir() {
                        check_and_add_media_file(&entry_path, &options.extensions, &mut media_items);
                        continue;
                    }

                    if !visited_canonical_paths.insert(canonical.clone()) {
                        warn!(
                            "Detected circular symlink/junction loop at {} -> {}. Skipping.",
                            entry_path.display(),
                            canonical.display()
                        );
                        continue;
                    }
                } else if let Ok(canonical) = fs::canonicalize(&entry_path) {
                    if !visited_canonical_paths.insert(canonical) {
                        warn!(
                            "Detected circular directory junction at {}. Skipping.",
                            entry_path.display()
                        );
                        continue;
                    }
                }

                queue.push_back((entry_path, current_depth + 1));
            } else if file_type.is_file() {
                check_and_add_media_file(&entry_path, &options.extensions, &mut media_items);
            }
        }
    }

    media_items.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    info!(
        "Directory scan complete. Discovered {} video files.",
        media_items.len()
    );
    Ok(media_items)
}

fn check_and_add_media_file(
    path: &Path,
    allowed_extensions: &[String],
    media_items: &mut Vec<MediaItem>,
) {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => {
            let lower = e.to_ascii_lowercase();
            if allowed_extensions.iter().any(|a| a.eq_ignore_ascii_case(&lower)) {
                Some(lower)
            } else {
                None
            }
        }
        None => None,
    };
    if let Some(ext) = ext {
        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(err) => {
                warn!(
                    "Could not retrieve metadata for file {}: {}. Skipping.",
                    path.display(),
                    err
                );
                return;
            }
        };

        let file_size_bytes = metadata.len();
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let clean_path = clean_path_display(path);
        let id = generate_deterministic_id(&clean_path, file_size_bytes);

        media_items.push(MediaItem {
            id,
            file_path: clean_path,
            file_name,
            file_size_bytes,
            extension: ext,
            metadata: None,
            poster_path: None,
        });
    }
}
