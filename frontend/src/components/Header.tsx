import React, { useState, useEffect, useMemo, useRef } from 'react';
import { PartyState, ServerStatus, TunnelStatus } from '../types/media';
import { api, isRemoteTunnelClient, isTauriEnvironment } from '../api/client';
import { generateQrMatrix } from '../utils/qrcode';

interface HeaderProps {
  serverStatus: ServerStatus | null;
  selectedDirectory: string | null;
  onSelectDirectory: (path?: string) => Promise<void>;
  isScanning: boolean;
  partyState?: PartyState | null;
  onPartyStateChange?: (state: PartyState | null) => void;
  onTunnelStatusChange?: (tunnel: TunnelStatus) => void;
  onKillTunnel?: () => Promise<void> | void;
}

export const Header: React.FC<HeaderProps> = ({
  serverStatus,
  selectedDirectory,
  onSelectDirectory,
  isScanning,
  partyState,
  onPartyStateChange,
  onTunnelStatusChange,
  onKillTunnel,
}) => {
  const [showPathModal, setShowPathModal] = useState(false);
  const [showQrPopover, setShowQrPopover] = useState(false);
  const [qrTargetMode, setQrTargetMode] = useState<'party' | 'lan'>('party');
  const [manualPath, setManualPath] = useState('');
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(
    serverStatus?.tunnel ?? null
  );
  const [isTunnelBusy, setIsTunnelBusy] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const autoCopiedUrlRef = useRef<string | null>(null);

  const isTauri = isTauriEnvironment();
  const isRemoteGuest = isRemoteTunnelClient();

  useEffect(() => {
    if (serverStatus?.tunnel) {
      setTunnelStatus(serverStatus.tunnel);
    }
  }, [serverStatus?.tunnel]);

  // Poll tunnel status rapidly while CONNECTING so the link & QR appear immediately
  useEffect(() => {
    if (!tunnelStatus?.active || tunnelStatus.status !== 'CONNECTING') {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const st = await api.getTunnelStatus();
        setTunnelStatus(st);
        onTunnelStatusChange?.(st);
        if (!st.active || st.status === 'ERROR') {
          api.resetParty().catch(() => {});
          onPartyStateChange?.(null);
          return;
        }
        if (st.invite_url && autoCopiedUrlRef.current !== st.invite_url) {
          autoCopiedUrlRef.current = st.invite_url;
          navigator.clipboard?.writeText(st.invite_url).then(() => {
            setCopiedLink(true);
            window.setTimeout(() => setCopiedLink(false), 2500);
          }).catch(() => {});
        }
      } catch {
        // ignore transient poll errors
      }
    }, 800);

    return () => window.clearInterval(timer);
  }, [tunnelStatus?.active, tunnelStatus?.status, onTunnelStatusChange, onPartyStateChange]);

  const lanUrl = serverStatus?.lan_ip
    ? `http://${serverStatus.lan_ip}:${serverStatus.port || 9000}`
    : `http://127.0.0.1:9000`;

  const isWatchPartyOn = Boolean(tunnelStatus?.active || partyState?.enabled);
  const activePeers = partyState?.active_peers ?? 1;

  // Toggle Watch Party ON (auto-starts tunnel & generates link + QR) or OFF (reverts to local network)
  const handleToggleWatchParty = async () => {
    if (isRemoteGuest || isTunnelBusy) return;
    setIsTunnelBusy(true);

    if (isWatchPartyOn) {
      // Turn Watch Party OFF -> kill tunnel (which resets party on backend) & revert to local network
      setShowQrPopover(false);
      autoCopiedUrlRef.current = null;
      try {
        await onKillTunnel?.();
        const st = await api.killTunnel();
        setTunnelStatus(st);
        onTunnelStatusChange?.(st);
        onPartyStateChange?.(null);
      } catch (err) {
        console.error('Failed to disable Watch Party:', err);
      } finally {
        setIsTunnelBusy(false);
      }
    } else {
      // Turn Watch Party ON -> auto-generate tunnel link + open QR, only enable party if tunnel holds
      setQrTargetMode('party');
      setShowQrPopover(true);
      try {
        const st = await api.startTunnel('cloudflare');
        setTunnelStatus(st);
        onTunnelStatusChange?.(st);
        if (!st.active || st.status === 'ERROR') {
          onPartyStateChange?.(null);
        } else {
          const pState = await api.getPartyState().catch(() => null);
          if (pState) onPartyStateChange?.(pState);
          if (st.invite_url) {
            autoCopiedUrlRef.current = st.invite_url;
            await handleCopyLink(st.invite_url);
          }
        }
      } catch (err) {
        console.error('Failed to enable Watch Party:', err);
        const failedStatus: TunnelStatus = {
          active: false,
          status: 'ERROR',
          provider: 'CLOUDFLARE',
          public_url: null,
          invite_token: tunnelStatus?.invite_token || '',
          invite_url: null,
          error: err instanceof Error ? err.message : 'FAILED TO START WATCH PARTY TUNNEL',
        };
        setTunnelStatus(failedStatus);
        onTunnelStatusChange?.(failedStatus);
        onPartyStateChange?.(null);
      } finally {
        setIsTunnelBusy(false);
      }
    }
  };

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

  const handleCopyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleSwitchProvider = async (providerId: string) => {
    if (isTunnelBusy) return;
    setIsTunnelBusy(true);
    try {
      const st = await api.startTunnel(providerId);
      setTunnelStatus(st);
      onTunnelStatusChange?.(st);
      if (!st.active || st.status === 'ERROR') {
        onPartyStateChange?.(null);
      } else {
        const pState = await api.getPartyState().catch(() => null);
        if (pState) onPartyStateChange?.(pState);
        if (st.invite_url) {
          autoCopiedUrlRef.current = st.invite_url;
          await handleCopyLink(st.invite_url);
        }
      }
    } catch (err) {
      console.error('Failed to switch tunnel provider:', err);
      const failedStatus: TunnelStatus = {
        active: false,
        status: 'ERROR',
        provider: providerId.toUpperCase(),
        public_url: null,
        invite_token: tunnelStatus?.invite_token || '',
        invite_url: null,
        error: err instanceof Error ? err.message : 'FAILED TO SWITCH TUNNEL PROVIDER',
      };
      setTunnelStatus(failedStatus);
      onTunnelStatusChange?.(failedStatus);
      onPartyStateChange?.(null);
    } finally {
      setIsTunnelBusy(false);
    }
  };

  // Active URL for the QR Code & direct share box (never fall back to LAN URL inside the Public Party tab)
  const activeShareUrl = useMemo(() => {
    if (qrTargetMode === 'party') {
      return tunnelStatus?.invite_url || '';
    }
    return lanUrl;
  }, [qrTargetMode, tunnelStatus?.invite_url, lanUrl]);

  const qrMatrix = useMemo(() => {
    if (!activeShareUrl) return null;
    try {
      return generateQrMatrix(activeShareUrl);
    } catch {
      return null;
    }
  }, [activeShareUrl]);

  const compactRootLabel = useMemo(() => {
    if (isRemoteGuest) return 'REMOTE PARTY GUEST';
    if (!selectedDirectory) return 'NO DIR';
    const norm = selectedDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = norm.split('/');
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : norm;
  }, [isRemoteGuest, selectedDirectory]);

  return (
    <>
      <header className="app-header">
        <div className="header-branding">
          {/* Cyber-Sigilism Thorny Blade Crest */}
          <svg
            className="sigil-emblem"
            viewBox="0 0 40 40"
            width="28"
            height="28"
            aria-hidden="true"
          >
            {/* Outer barbed spine & asymmetric needle horns */}
            <path
              d="M20 1 L21.8 14.5 L39 20 L21.8 25.5 L20 39 L18.2 25.5 L1 20 L18.2 14.5 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M7 7 C13 13, 15 15, 20 12 C25 15, 27 13, 33 7 C27 15, 25 17, 28 20 C25 23, 27 25, 33 33 C27 27, 25 25, 20 28 C15 25, 13 27, 7 33 C13 25, 15 23, 12 20 C15 17, 13 15, 7 7 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.95"
            />
            {/* Core diamond reticle */}
            <polygon points="20,14 23,20 20,26 17,20" fill="currentColor" />
            <circle cx="20" cy="20" r="9.5" fill="none" stroke="currentColor" strokeWidth="0.7" strokeDasharray="2 2" />
          </svg>

          <div className="header-title-group">
            <div className="header-title-row">
              <h1 className="header-title">MONOLITH</h1>
              <svg className="sigil-inline-spine" viewBox="0 0 28 12" width="22" height="10" aria-hidden="true">
                <path d="M0 6 L10 6 L14 1 L18 6 L28 6 M10 6 L14 11 L18 6" fill="none" stroke="currentColor" strokeWidth="1.1" />
                <circle cx="14" cy="6" r="1.4" fill="currentColor" />
              </svg>
              <span
                className="badge header-root-badge"
                title={selectedDirectory || 'No directory loaded'}
              >
                {compactRootLabel}
              </span>
            </div>
          </div>
        </div>

        <div className="header-actions">
          {/* Network Mode & Direct Link Copy / Open */}
          {isWatchPartyOn && tunnelStatus?.invite_url ? (
            <button
              type="button"
              className="status-link-btn"
              onClick={() => handleCopyLink(tunnelStatus.invite_url!)}
              title="Click to copy Watch Party invite link"
            >
              {copiedLink ? '[✦ LINK COPIED]' : '[⧉ COPY PARTY LINK]'}
            </button>
          ) : isWatchPartyOn && tunnelStatus?.status === 'CONNECTING' ? (
            <span className="badge badge-inverted">
              <span className="loading-spinner">✦</span> [GENERATING LINK...]
            </span>
          ) : (
            <button
              type="button"
              className="status-link-btn"
              onClick={() => api.openUrlInBrowser(lanUrl)}
              title="Local Network Stream URL (click to open in browser)"
            >
              LAN // {lanUrl.replace(/^https?:\/\//, '')} ↗
            </button>
          )}

          {/* Active Peers Counter when Watch Party is On */}
          {(isWatchPartyOn || activePeers > 1) && (
            <span className="badge badge-inverted" title="Connected Watch Party peers">
              [PEERS: {activePeers}]
            </span>
          )}

          {/* QR Code Popover Button (works for both Watch Party Link & Local LAN) */}
          {!isRemoteGuest && (
            <button
              type="button"
              className={`brutalist-btn sm ${showQrPopover ? 'active' : ''}`}
              onClick={() => {
                setQrTargetMode(isWatchPartyOn ? 'party' : 'lan');
                setShowQrPopover((v) => !v);
              }}
              title="Show scannable QR code for phone"
            >
              [⌖ QR]
            </button>
          )}

          {/* Direct Watch Party ON / OFF Toggle */}
          {!isRemoteGuest && (
            <button
              type="button"
              role="switch"
              aria-checked={isWatchPartyOn}
              className={`brutalist-btn sm watch-party-toggle ${isWatchPartyOn ? 'active' : ''}`}
              onClick={handleToggleWatchParty}
              disabled={isTunnelBusy}
              title={
                isWatchPartyOn
                  ? 'Toggle OFF to kill Watch Party link and return to local network only'
                  : 'Toggle ON to enable Watch Party and auto-generate shareable link + QR code'
              }
            >
              <span className="toggle-indicator" aria-hidden="true">
                {isTunnelBusy ? '✦' : isWatchPartyOn ? '◉' : '○'}
              </span>
              <span>
                WATCH PARTY: {isTunnelBusy ? 'SYNC...' : isWatchPartyOn ? 'ON' : 'OFF'}
              </span>
            </button>
          )}

          {/* Root Directory Scan Trigger */}
          {!isRemoteGuest && (
            <button
              type="button"
              className="brutalist-btn sm"
              onClick={handleSelectClick}
              disabled={isScanning}
              title="Select or scan media library directory"
            >
              {isScanning ? (
                <>
                  <span className="loading-spinner">■</span> [SCANNING...]
                </>
              ) : (
                '[◈ SCAN DIR]'
              )}
            </button>
          )}
        </div>
      </header>

      {/* Anchored Cyber-Sigil QR Code & Watch Party Link HUD Popover */}
      {showQrPopover && !isRemoteGuest && (
        <div className="qr-popover-backdrop" onClick={() => setShowQrPopover(false)}>
          <div
            className="qr-hud-popover"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Watch Party Link and Phone QR Scanner"
          >
            <div className="qr-popover-header">
              <span>
                {qrTargetMode === 'party' && (isWatchPartyOn || isTunnelBusy || tunnelStatus?.status === 'ERROR')
                  ? '✦ WATCH PARTY // PHONE QR & LINK ✦'
                  : '✦ LOCAL LAN // PHONE QR ✦'}
              </span>
              <button
                type="button"
                className="brutalist-btn sm"
                onClick={() => setShowQrPopover(false)}
              >
                [✕]
              </button>
            </div>

            {(isWatchPartyOn || isTunnelBusy || tunnelStatus?.status === 'ERROR' || Boolean(tunnelStatus?.error)) && (
              <div className="qr-mode-tabs">
                <button
                  type="button"
                  className={`brutalist-btn sm ${qrTargetMode === 'party' ? 'active' : ''}`}
                  onClick={() => setQrTargetMode('party')}
                >
                  [PUBLIC WATCH PARTY LINK]
                </button>
                <button
                  type="button"
                  className={`brutalist-btn sm ${qrTargetMode === 'lan' ? 'active' : ''}`}
                  onClick={() => setQrTargetMode('lan')}
                >
                  [LOCAL WI-FI LAN]
                </button>
              </div>
            )}

            {/* QR Canvas Box */}
            <div className="qr-frame-container">
              {qrTargetMode === 'party' &&
              (isTunnelBusy || (tunnelStatus?.status === 'CONNECTING' && !tunnelStatus?.invite_url)) ? (
                <div className="qr-connecting-state">
                  <span className="loading-spinner" style={{ fontSize: '1.6rem' }}>
                    ✦
                  </span>
                  <div>[ESTABLISHING ENCRYPTED TUNNEL...]</div>
                  <div style={{ fontSize: '0.68rem', opacity: 0.7 }}>
                    LINK & QR WILL APPEAR AUTOMATICALLY
                  </div>
                </div>
              ) : qrTargetMode === 'party' && !tunnelStatus?.invite_url ? (
                <div className="qr-connecting-state qr-error-state">
                  <div style={{ fontWeight: 900 }}>[PUBLIC TUNNEL UNAVAILABLE]</div>
                  <div style={{ fontSize: '0.66rem', opacity: 0.8 }}>
                    {tunnelStatus?.error || 'PUBLIC LINK COULD NOT BE GENERATED.'}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'center', marginTop: '6px' }}>
                    <button
                      type="button"
                      className="brutalist-btn sm"
                      onClick={() => handleSwitchProvider('cloudflare')}
                      disabled={isTunnelBusy}
                    >
                      [RETRY]
                    </button>
                    <button
                      type="button"
                      className="brutalist-btn sm"
                      onClick={() => handleSwitchProvider('localhost.run')}
                      disabled={isTunnelBusy}
                    >
                      [SSH TUNNEL]
                    </button>
                    <button
                      type="button"
                      className="brutalist-btn sm active"
                      onClick={() => setQrTargetMode('lan')}
                    >
                      [LOCAL WI-FI QR]
                    </button>
                  </div>
                </div>
              ) : qrMatrix ? (
                <div className="qr-svg-wrapper">
                  <svg
                    viewBox={`0 0 ${qrMatrix.length + 8} ${qrMatrix.length + 8}`}
                    className="qr-svg"
                    shapeRendering="crispEdges"
                    role="img"
                    aria-label={`QR Code for ${activeShareUrl}`}
                  >
                    <rect
                      x="0"
                      y="0"
                      width={qrMatrix.length + 8}
                      height={qrMatrix.length + 8}
                      fill="#ffffff"
                    />
                    {qrMatrix.map((row, r) =>
                      row.map((cell, c) =>
                        cell ? (
                          <rect
                            key={`${r}-${c}`}
                            x={c + 4}
                            y={r + 4}
                            width={1}
                            height={1}
                            fill="#000000"
                          />
                        ) : null
                      )
                    )}
                  </svg>
                </div>
              ) : activeShareUrl ? (
                <div className="qr-connecting-state qr-error-state">
                  <div style={{ fontWeight: 900 }}>[QR PAYLOAD TOO LONG]</div>
                  <div style={{ fontSize: '0.66rem', opacity: 0.8 }}>
                    USE [COPY] BELOW TO SHARE THIS LINK.
                  </div>
                </div>
              ) : null}

              <div className="qr-scan-caption">
                {qrTargetMode === 'party' &&
                (isTunnelBusy || (tunnelStatus?.status === 'CONNECTING' && !tunnelStatus?.invite_url))
                  ? 'GENERATING SCANNABLE WATCH PARTY QR...'
                  : qrTargetMode === 'party' && !tunnelStatus?.invite_url
                  ? 'SWITCH TO [LOCAL WI-FI LAN] OR RETRY TUNNEL'
                  : 'SCAN WITH PHONE CAMERA TO OPEN STREAM DIRECTLY'}
              </div>
            </div>

            {tunnelStatus?.error && qrTargetMode === 'party' && tunnelStatus?.invite_url && (
              <div className="tunnel-error-text">
                [TUNNEL NOTICE]: {tunnelStatus.error}
              </div>
            )}

            {/* Direct URL Input & Copy */}
            {activeShareUrl && (
              <div className="invite-link-box">
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    readOnly
                    className="search-input"
                    value={activeShareUrl}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    type="button"
                    className="brutalist-btn sm active"
                    onClick={() => handleCopyLink(activeShareUrl)}
                  >
                    {copiedLink ? '[COPIED!]' : '[COPY]'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Path input modal for Web LAN clients without native Tauri dialog */}
      {showPathModal && (
        <div className="modal-overlay" onClick={() => setShowPathModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-row">
              <h3>[✦ ENTER SERVER MEDIA DIRECTORY]</h3>
              <button
                type="button"
                className="brutalist-btn sm"
                onClick={() => setShowPathModal(false)}
              >
                [✕]
              </button>
            </div>
            <p className="modal-desc">
              Enter the absolute path on the host server to scan for media files (.mkv, .mp4, .webm,
              .avi).
            </p>
            <form
              onSubmit={handleManualSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
            >
              <input
                type="text"
                className="search-input"
                placeholder="E.G. C:\MEDIA\MOVIES OR /DATA/MEDIA"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                autoFocus
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                <button
                  type="button"
                  className="brutalist-btn sm"
                  onClick={() => setShowPathModal(false)}
                >
                  [CANCEL]
                </button>
                <button type="submit" className="brutalist-btn sm active">
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
