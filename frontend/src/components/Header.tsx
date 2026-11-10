import React, { useState } from 'react';
import { ServerStatus } from '../types/media';
import { isTauriEnvironment } from '../api/client';

interface HeaderProps {
  serverStatus: ServerStatus | null;
  selectedDirectory: string | null;
  onSelectDirectory: (path?: string) => Promise<void>;
  isScanning: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  serverStatus,
  selectedDirectory,
  onSelectDirectory,
  isScanning,
}) => {
  const [showPathModal, setShowPathModal] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const isTauri = isTauriEnvironment();

  const handleSelectClick = async () => {
    if (isTauri) {
      // In Tauri desktop, native dialog picker is invoked directly
      await onSelectDirectory();
    } else {
      // In web browser mode, prompt for directory path or confirm
      setShowPathModal(true);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowPathModal(false);
    await onSelectDirectory(manualPath.trim() || undefined);
    setManualPath('');
  };

  // Dynamic LAN URL shown both in the .exe and on web clients
  const lanUrl = serverStatus?.lan_ip
    ? `http://${serverStatus.lan_ip}:${serverStatus.port || 9000}`
    : `http://127.0.0.1:9000`;

  return (
    <>
      <header className="app-header">
        <div className="header-branding">
          <img
            src="/logo.png"
            alt="Monolith Logo"
            className="header-logo"
            onError={(e) => {
              // Fallback if logo not found at /logo.png
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
          <div className="header-title-group">
            <h1 className="header-title">MONOLITH // OFFLINE STREAMING</h1>
            <span className="header-subtitle">
              LOCAL-FIRST HARDWARE-ACCELERATED MEDIA MATRIX
            </span>
          </div>
        </div>

        <div className="header-actions">
          <span className="badge badge-inverted" title="Open this URL on any device on your Wi-Fi / LAN">
            [LAN URL: {lanUrl}]
          </span>

          <button
            type="button"
            className="brutalist-btn"
            onClick={handleSelectClick}
            disabled={isScanning}
          >
            {isScanning ? (
              <>
                <span className="loading-spinner">■</span> [SCANNING MEDIA...]
              </>
            ) : (
              '[SELECT ROOT DIRECTORY]'
            )}
          </button>
        </div>
      </header>

      {/* Secondary Status & Path Bar */}
      <div className="status-bar">
        <div className="status-group">
          <span>ROOT:</span>
          <span className="badge">
            {selectedDirectory ? selectedDirectory : '[NO DIRECTORY LOADED]'}
          </span>
        </div>
        <div className="status-group">
          <span>STREAM URL:</span>
          <span className="badge badge-inverted">{lanUrl}</span>
        </div>
      </div>

      {/* Path input modal for Web LAN clients without native Tauri dialog */}
      {showPathModal && (
        <div className="modal-overlay" onClick={() => setShowPathModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 900 }}>[ENTER SERVER MEDIA DIRECTORY]</h3>
            <p style={{ fontSize: '0.9rem', opacity: 0.85 }}>
              Enter the absolute path on the host server to scan for media files (.mkv, .mp4, .webm, .avi). Leave empty to use default.
            </p>
            <form onSubmit={handleManualSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <input
                type="text"
                className="search-input"
                placeholder="E.G. C:\MEDIA\MOVIES OR /DATA/MEDIA"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                autoFocus
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  className="brutalist-btn sm"
                  onClick={() => setShowPathModal(false)}
                >
                  [CANCEL]
                </button>
                <button type="submit" className="brutalist-btn sm badge-inverted">
                  [START SCAN]
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
