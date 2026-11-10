use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::error::AppError;

/// Computes a deterministic SHA-256 hash of a file's contents, returning a 64-character lowercase hex string.
pub fn compute_sha256(path: &Path) -> Result<String, AppError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_compute_sha256() {
        let mut tmp = NamedTempFile::new().unwrap();
        tmp.write_all(b"Monolith offline test content").unwrap();
        let hash = compute_sha256(tmp.path()).unwrap();
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
