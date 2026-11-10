use std::process::Command;
use std::sync::OnceLock;
use tracing::info;

use crate::metadata::find_ffmpeg;

static NVENC_PROBE_CACHE: OnceLock<bool> = OnceLock::new();

/// Runtime probe to detect whether NVIDIA NVENC CUDA encoding is available on the host.
/// Executes: `ffmpeg -v error -f lavfi -i color=c=black:s=256x256:d=0.1 -c:v h264_nvenc -f null -`
pub fn probe_nvenc_available() -> bool {
    *NVENC_PROBE_CACHE.get_or_init(|| {
        let ffmpeg = find_ffmpeg();
        let status = Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=256x256:d=0.1",
                "-c:v",
                "h264_nvenc",
                "-f",
                "null",
                "-",
            ])
            .status();

        match status {
            Ok(s) if s.success() => {
                info!("Hardware acceleration probe: NVIDIA NVENC CUDA is AVAILABLE");
                true
            }
            Ok(s) => {
                info!(
                    "Hardware acceleration probe: NVIDIA NVENC unavailable (code {:?}), falling back to CPU libx264",
                    s.code()
                );
                false
            }
            Err(e) => {
                info!(
                    "Hardware acceleration probe: Failed to execute ffmpeg probe ({}), falling back to CPU libx264",
                    e
                );
                false
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_probe_nvenc_runs_without_panic() {
        let _ = probe_nvenc_available();
    }
}
