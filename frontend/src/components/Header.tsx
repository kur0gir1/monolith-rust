import React, { useState, useEffect } from 'react';
import { PartyState, ServerStatus, TunnelStatus } from '../types/media';
import { api, isRemoteTunnelClient, isTauriEnvironment } from '../api/client';

interface HeaderProps {
  serverStatus: ServerStatus | null;
  selectedDirectory: string | null;
  onSelectDirectory: (path?: string) => Promise<void>;
  isScanning: boolean;
  partyState?: PartyState | null;
}

export const Header: React.FC<HeaderProps> = ({
  serverStatus,
  selectedDirectory,
  onSelectDirectory,
  isScanning,
  partyState,
}) => {
  const [showPathModal, setShowPathModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<string>('cloudflare');
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(
    serverStatus?.tunnel ?? null
  );
  const [isTunnelBusy, setIsTunnelBusy] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);

  const isTauri = isTauriEnvironment();
  const isRemoteGuest = isRemoteTunnelClient();

  useEffect(() => {
    if (serverStatus?.tunnel) {
      setTunnelStatus(serverStatus.tunnel);
    }
  }, [serverStatus?.tunnel]);

  const handleSelectClick = async () => {
    if (isRemoteGuest) return;
    if (isTauri) {
      await onSelectDirectory();
    } else {
      setShowPathModal(true);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowPathModal(false);
    await onSelectDirectory(manualPath.trim() || undefined);
    setManualPath('');
  };

  const handleStartTunnel = async () => {
    setIsTunnelBusy(true);
    try {
      const st = await api.startTunnel(selectedProvider);
      setTunnelStatus(st);
    } catch (err) {
      console.error('Failed to start tunnel:', err);
    } finally {
      setIsTunnelBusy(false);
    }
  };

  const handleStopTunnel = async () => {
    setIsTunnelBusy(true);
    try {
      const st = await api.stopTunnel();
      setTunnelStatus(st);
    } catch (err) {
      console.error('Failed to stop tunnel:', err);
    } finally {
      setIsTunnelBusy(false);
    }
  };

  const handleKillTunnel = async () => {
    setIsTunnelBusy(true);
    try {
      const st = await api.killTunnel();
      setTunnelStatus(st);
    } catch (err) {
      console.error('Failed to kill tunnel:', err);
    } finally {
      setIsTunnelBusy(false);
    }
  };

  const handleRotateToken = async () => {
    setIsTunnelBusy(true);
    try {
      const st = await api.rotateTunnelToken();
      setTunnelStatus(st);
    } catch (err) {
      console.error('Failed to rotate invite token:', err);
    } finally {
      setIsTunnelBusy(false);
    }
  };

  const handleCopyInvite = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInvite(true);
      window.setTimeout(() => setCopiedInvite(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const lanUrl = serverStatus?.lan_ip
    ? `http://${serverStatus.lan_ip}:${serverStatus.port || 9000}`
    : `http://127.0.0.1:9000`;

  const activePeers = partyState?.active_peers ?? 1;

  return (
    <>
      <header className="app-header">
        <div className="header-branding">
          <img
            src="/logo.png"
            alt="Monolith Logo"
            className="header-logo"
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
          <div className="header-title-group">
            <h1 className="header-title">MONOLITH</h1>
            <span className="header-subtitle">
              LOCAL-FIRST HARDWARE-ACCELERATED MEDIA MATRIX
            </span>
          </div>
        </div>

        <div className="header-actions">
          {activePeers > 1 && (
            <span className="badge badge-inverted" title="Connected Watch Party viewers">
              [WATCH PARTY: {activePeers} ONLINE]
            </span>
          )}

          {!isRemoteGuest && (
            <button
              type="button"
              className={`brutalist-btn ${tunnelStatus?.status === 'ONLINE' ? 'active' : ''}`}
              onClick={() => setShowShareModal(true)}
            >
              {tunnelStatus?.status === 'ONLINE'
                ? '[TUNNEL LIVE // INVITE LINK]'
                : '[SHARE // WATCH TOGETHER]'}
            </button>
          )}

          {!isRemoteGuest && (
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
          )}
        </div>
      </header>

      {/* Secondary Status & Clickable Stream URL Bar */}
      <div className="status-bar">
        <div className="status-group">
          <span className="status-label">ROOT:</span>
          <span className="badge">
            {isRemoteGuest
              ? '[REMOTE WATCH PARTY SESSION]'
              : selectedDirectory
              ? selectedDirectory
              : '[NO DIRECTORY LOADED]'}
          </span>
        </div>

        <div className="status-group">
          {tunnelStatus?.status === 'ONLINE' && tunnelStatus.invite_url && !isRemoteGuest && (
            <>
              <span className="status-label">INVITE:</span>
              <button
                type="button"
                className="status-link-btn"
                onClick={() => handleCopyInvite(tunnelStatus.invite_url!)}
                title="Click to copy encrypted Watch Party invite link"
              >
                {copiedInvite ? '[COPIED INVITE LINK!]' : '[COPY ENCRYPTED INVITE ⧉]'}
              </button>
              <button
                type="button"
                className="status-link-btn"
                style={{ background: '#1c0505', color: '#f87171', borderColor: '#ef4444' }}
                onClick={handleKillTunnel}
                disabled={isTunnelBusy}
                title="Immediately terminate tunnel and invalidate invite token"
              >
                [KILL LINK ✕]
              </button>
            </>
          )}

          <span className="status-label">STREAM URL:</span>
          <button
            type="button"
            className="status-link-btn"
            onClick={() => api.openUrlInBrowser(lanUrl)}
            title="Click to open LAN Stream URL in your browser"
          >
            {lanUrl} ↗
          </button>
        </div>
      </div>

      {/* Encrypted Tunnel & Watch Party Share Modal */}
      {showShareModal && (
        <div className="modal-overlay" onClick={() => setShowShareModal(false)}>
          <div className="modal-content share-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-row">
              <h3>[SHARE // ENCRYPTED WATCH PARTY]</h3>
              <button
                type="button"
                className="brutalist-btn sm"
                onClick={() => setShowShareModal(false)}
              >
                [X CLOSE]
              </button>
            </div>

            <p className="modal-desc">
              Create a TLS-encrypted public tunnel with a 128-bit invite token. Friends with the
              invite link can stream and share playback controls (Play, Pause, Seek) in real-time
              without port-forwarding.
            </p>

            <div className="share-provider-section">
              <span className="status-label">SELECT ENCRYPTED TUNNEL PROVIDER:</span>
              <div className="provider-grid">
                {[
                  {
                    id: 'cloudflare',
                    label: 'CLOUDFLARE QUICK TUNNEL',
                    desc: 'FASTEST // GLOBAL EDGE ANYCAST CDN // HIGH BANDWIDTH // RECOMMENDED',
                  },
                  {
                    id: 'localhost.run',
                    label: 'LOCALHOST.RUN (SSH TLS)',
                    desc: 'BACKUP // BUILT-IN WINDOWS OPENSSH // REVERSE TUNNEL',
                  },
                  {
                    id: 'serveo.net',
                    label: 'SERVEO.NET (SSH TLS)',
                    desc: 'ALTERNATIVE // SSH REVERSE TUNNEL OVER HTTPS',
                  },
                ].map((prov) => (
                  <div
                    key={prov.id}
                    className={`provider-option ${selectedProvider === prov.id ? 'selected' : ''}`}
                    onClick={() => setSelectedProvider(prov.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="provider-option-title">[{prov.label}]</div>
                    <div className="provider-option-desc">{prov.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="share-status-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="status-label">
                  TUNNEL STATUS: <strong>{tunnelStatus?.status || 'OFFLINE'}</strong>
                </span>
                <span className="badge">{tunnelStatus?.provider || 'READY'}</span>
              </div>

              {tunnelStatus?.error && (
                <div className="tunnel-error-text">[ERROR]: {tunnelStatus.error}</div>
              )}

              {tunnelStatus?.invite_url ? (
                <div className="invite-link-box">
                  <span className="status-label">ENCRYPTED INVITE LINK (HTTPS + TOKEN):</span>
                  <input
                    type="text"
                    readOnly
                    className="search-input"
                    value={tunnelStatus.invite_url}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
                    <button
                      type="button"
                      className="brutalist-btn sm active"
                      onClick={() => handleCopyInvite(tunnelStatus.invite_url!)}
                    >
                      {copiedInvite ? '[COPIED TO CLIPBOARD!]' : '[COPY INVITE LINK]'}
                    </button>
                    <button
                      type="button"
                      className="brutalist-btn sm"
                      onClick={() => api.openUrlInBrowser(tunnelStatus.invite_url!)}
                    >
                      [OPEN IN BROWSER ↗]
                    </button>
                    <button
                      type="button"
                      className="brutalist-btn sm"
                      onClick={handleRotateToken}
                      disabled={isTunnelBusy}
                    >
                      [NEW TOKEN]
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ opacity: 0.75, fontSize: '0.8rem' }}>
                  Click [START ENCRYPTED TUNNEL] below to generate a shareable HTTPS invite URL.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              {tunnelStatus?.active && (
                <>
                  <button
                    type="button"
                    className="brutalist-btn sm"
                    onClick={handleStopTunnel}
                    disabled={isTunnelBusy}
                  >
                    [STOP TUNNEL]
                  </button>
                  <button
                    type="button"
                    className="brutalist-btn sm"
                    style={{ background: '#7f1d1d', color: '#fff', borderColor: '#ef4444' }}
                    onClick={handleKillTunnel}
                    disabled={isTunnelBusy}
                    title="Terminate tunnel process and permanently invalidate invite link"
                  >
                    [KILL INVITE LINK]
                  </button>
                </>
              )}
              <button
                type="button"
                className="brutalist-btn sm active"
                onClick={handleStartTunnel}
                disabled={isTunnelBusy}
              >
                {isTunnelBusy
                  ? '[CONNECTING TUNNEL...]'
                  : tunnelStatus?.active
                  ? '[RESTART TUNNEL]'
                  : '[START ENCRYPTED TUNNEL]'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Path input modal for Web LAN clients without native Tauri dialog */}
      {showPathModal && (
        <div className="modal-overlay" onClick={() => setShowPathModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>[ENTER SERVER MEDIA DIRECTORY]</h3>
            <p className="modal-desc">
              Enter the absolute path on the host server to scan for media files (.mkv, .mp4, .webm,
              .avi). Leave empty to use default.
            </p>
            <form
              onSubmit={handleManualSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
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
