use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Directory scan error: {0}")]
    ScanError(String),

    #[error("Path not found: {0}")]
    NotFound(String),

    #[error("Invalid directory path: {0}")]
    InvalidPath(String),

    #[error("Folder picker dialog was canceled by user")]
    DialogCanceled,

    #[error("Media item not found: {0}")]
    MediaNotFound(String),

    #[error("External process execution error: {0}")]
    ProcessError(String),

    #[error("Transcoder error: {0}")]
    TranscodeError(String),

    #[error("Hardware acceleration probe error: {0}")]
    HardwareProbeError(String),

    #[error("Task join error: {0}")]
    JoinError(String),

    #[error("Internal error: {0}")]
    Other(String),
}

// Serialize as string for clean Tauri IPC transmission
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Map AppError into HTTP Responses for Axum endpoints
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, err_body) = match &self {
            AppError::MediaNotFound(id) => (
                StatusCode::NOT_FOUND,
                serde_json::json!({
                    "error": "Media item not found",
                    "id": id,
                    "message": self.to_string()
                }),
            ),
            AppError::NotFound(msg) => (
                StatusCode::NOT_FOUND,
                serde_json::json!({
                    "error": "Not found",
                    "message": msg
                }),
            ),
            AppError::InvalidPath(msg) => (
                StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "error": "Invalid path",
                    "message": msg
                }),
            ),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({
                    "error": "Internal server error",
                    "message": self.to_string()
                }),
            ),
        };

        (status, Json(err_body)).into_response()
    }
}
