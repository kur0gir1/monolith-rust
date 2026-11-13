import React, { useEffect, useState, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import { MediaItem, PartyState, ServerStatus, TunnelStatus } from './types/media';
import { api, isGuestClient, setInviteTokenManual } from './api/client';
import { NoiseOverlay } from './components/NoiseOverlay';
import { Header } from './components/Header';
import { MediaBrowser } from './components/MediaBrowser';
import {
  WatchProgressMap,
  loadWatchProgress,
  updateVideoProgressMap,
} from './utils/watchProgress';

const VideoPlayer = lazy(() =>
  import('./components/VideoPlayer').then((m) => ({ default: m.VideoPlayer }))
);

export const App: React.FC = () => {
  const [view, setView] = useState<'browser' | 'player'>('browser');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [watchProgress, setWatchProgress] = useState<WatchProgressMap>(loadWatchProgress);
  const [partyState, setPartyState] = useState<PartyState | null>(null);
  const [needsInviteAuth, setNeedsInviteAuth] = useState(false);
  const [inviteInput, setInviteInput] = useState('');
  const syncEpochRef = useRef(0);
  const isGuest = isGuestClient();

  const handleProgressUpdate = useCallback(
    (mediaId: string, currentTime: number, duration: number) => {
      setWatchProgress((prev) => updateVideoProgressMap(prev, mediaId, currentTime, duration));
    },
    []
  );

  // Fetch initial catalog, server telemetry, and directory
  const loadData = useCallback(async () => {
    try {
      const items = await api.getMediaItems();
      setMediaItems(items);
      setNeedsInviteAuth(false);
    } catch (err) {
      if (err instanceof Error && err.message === 'UNAUTHORIZED_INVITE') {
        setNeedsInviteAuth(true);
        return;
      }
    }

    try {
      const status = await api.getServerStatus();
      setServerStatus(status);
    } catch {
      // Server telemetry endpoint may be initializing
    }

    try {
      const dir = await api.getSelectedDirectory();
      setSelectedDirectory(dir);
    } catch {
      // Not in Tauri or no directory selected yet
    }
  }, []);

  useEffect(() => {
    loadData();

    // Periodic telemetry ping every 8s
    const statusInterval = setInterval(() => {
      const epoch = syncEpochRef.current;
      api
        .getServerStatus()
        .then((s) => {
          if (syncEpochRef.current === epoch) {
            setServerStatus(s);
          }
        })
        .catch(() => {});
    }, 8000);

    // Watch Party heartbeat & state sync every 1.2s
    const partyInterval = setInterval(() => {
      const epoch = syncEpochRef.current;
      api
        .getPartyState()
        .then((p) => {
          if (syncEpochRef.current === epoch) {
            setPartyState(p);
          }
        })
        .catch(() => {});
    }, 1200);

    const handleUnload = () => {
      api.leaveParty();
    };

    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);

    return () => {
      clearInterval(statusInterval);
      clearInterval(partyInterval);
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
      handleUnload();
    };
  }, [loadData]);

  // Handle directory selection and scan
  const handleSelectDirectory = async (path?: string) => {
    setIsScanning(true);
    setErrorNotice(null);

    try {
      const scannedItems = await api.selectAndScanDirectory(path);
      setMediaItems(scannedItems);
      const activeDir = await api.getSelectedDirectory();
      setSelectedDirectory(activeDir || path || null);
    } catch (err) {
      console.error('Scan error:', err);
      setErrorNotice(err instanceof Error ? err.message : 'FAILED TO SCAN MEDIA DIRECTORY');
    } finally {
      setIsScanning(false);
    }
  };

  const handleSelectItem = (item: MediaItem) => {
    setSelectedItem(item);
    setView('player');
    if (partyState?.enabled || serverStatus?.tunnel?.active) {
      api
        .updatePartyState({
          media_id: item.id,
          media_title: item.file_name,
          is_playing: true,
          current_time: watchProgress[item.id]?.currentTime ?? 0,
        })
        .then((p) => setPartyState(p))
        .catch(() => {});
    }
  };

  const handleJoinPartyMedia = () => {
    if (!partyState?.media_id) return;
    const match = mediaItems.find((m) => m.id === partyState.media_id);
    if (match) {
      setSelectedItem(match);
      setView('player');
    }
  };

  const handleBackToBrowser = () => {
    setView('browser');
    setSelectedItem(null);
  };

  // Episodes = videos in the same folder as the one playing, in natural order (E2 before E10).
  const playlist = useMemo(() => {
    if (!selectedItem) return [];
    const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '').toLowerCase();
    const folder = folderOf(selectedItem.file_path);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return mediaItems
      .filter((m) => folderOf(m.file_path) === folder)
      .sort((a, b) => collator.compare(a.file_name, b.file_name));
  }, [mediaItems, selectedItem]);

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let token = inviteInput.trim();
    if (token.includes('invite=')) {
      const after = token.split('invite=')[1];
      token = after.split('&')[0];
    }
    setInviteTokenManual(token);
    setInviteInput('');
    await loadData();
  };

  const handleKillTunnel = useCallback(() => {
    syncEpochRef.current += 1;
    setPartyState(null);
  }, []);

  const handlePartyStateChange = useCallback((state: PartyState | null) => {
    syncEpochRef.current += 1;
    setPartyState(state);
  }, []);

  const handleTunnelStatusChange = useCallback((tunnel: TunnelStatus) => {
    syncEpochRef.current += 1;
    setServerStatus((prev) =>
      prev
        ? { ...prev, tunnel }
        : {
            lan_ip: '127.0.0.1',
            port: 9000,
            gpu_available: false,
            transcoder: 'CPU LIBX264',
            tunnel,
          }
    );
  }, []);

  return (
    <div className={`app-container ${view === 'player' ? 'player-mode' : ''}`}>
      {/* Global Grainy SVG Terminal Noise Overlay */}
      <NoiseOverlay />

      {/* Cyber-Sigil Brutalist Header */}
      <Header
        serverStatus={serverStatus}
        selectedDirectory={selectedDirectory}
        onSelectDirectory={handleSelectDirectory}
        onRefreshLibrary={loadData}
        isScanning={isScanning}
        partyState={partyState}
        onPartyStateChange={handlePartyStateChange}
        onTunnelStatusChange={handleTunnelStatusChange}
        onKillTunnel={handleKillTunnel}
      />

      {/* Main View Area */}
      <main className="app-main">
        {needsInviteAuth ? (
          <div className="empty-state">
            <h2>[ENCRYPTED INVITE TOKEN REQUIRED]</h2>
            <p className="modal-desc">
              This Monolith stream is protected. Paste the invite link or token shared by the host
              to join the Watch Party.
            </p>
            <form
              onSubmit={handleInviteSubmit}
              style={{ display: 'flex', gap: '8px', width: '100%', maxWidth: '420px' }}
            >
              <input
                type="text"
                className="search-input"
                placeholder="PASTE INVITE LINK OR TOKEN..."
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                autoFocus
              />
              <button type="submit" className="brutalist-btn active">
                [UNLOCK]
              </button>
            </form>
          </div>
        ) : (
          <>
            {errorNotice && (
              <div className="error-banner">
                <span>[ERROR]: {errorNotice}</span>
                <button
                  type="button"
                  className="brutalist-btn sm"
                  onClick={() => setErrorNotice(null)}
                >
                  [DISMISS]
                </button>
              </div>
            )}

            {/* Watch Party Live Banner when someone is watching a video */}
            {view === 'browser' &&
              partyState?.enabled &&
              partyState?.media_id &&
              (partyState.is_playing || partyState.active_peers > 1) &&
              mediaItems.some((m) => m.id === partyState.media_id) && (
                <div className="party-live-banner">
                  <div className="party-live-banner-content">
                    <span className="badge badge-inverted">
                      [WATCH PARTY LIVE]
                    </span>
                    <strong className="party-media-title">{partyState.media_title || 'SHARED STREAM'}</strong>
                    <span className="party-status-time">
                      ({partyState.is_playing ? 'PLAYING' : 'PAUSED'} //{' '}
                      {Math.floor(partyState.current_time / 60)}:
                      {Math.floor(partyState.current_time % 60)
                        .toString()
                        .padStart(2, '0')}
                      )
                    </span>
                  </div>
                  <button
                    type="button"
                    className="brutalist-btn sm active"
                    onClick={handleJoinPartyMedia}
                  >
                    [JOIN STREAM NOW ▶]
                  </button>
                </div>
              )}

            {view === 'browser' ? (
              <MediaBrowser
                items={mediaItems}
                rootDirectory={selectedDirectory}
                watchProgress={watchProgress}
                onSelectItem={handleSelectItem}
                onTriggerScan={() => handleSelectDirectory()}
                onRefresh={loadData}
                isScanning={isScanning}
                isGuest={isGuest}
              />
            ) : selectedItem ? (
              <Suspense
                fallback={
                  <div className="empty-state">
                    <span className="loading-spinner">■</span>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>
                      [LOADING VIDEO ENGINE...]
                    </div>
                  </div>
                }
              >
                <VideoPlayer
                  key={selectedItem.id}
                  item={selectedItem}
                  serverStatus={serverStatus}
                  partyState={partyState}
                  initialProgress={watchProgress[selectedItem.id]}
                  onProgressUpdate={handleProgressUpdate}
                  onBack={handleBackToBrowser}
                  playlist={playlist}
                  watchProgress={watchProgress}
                  onSelectItem={handleSelectItem}
                />
              </Suspense>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
};

export default App;
