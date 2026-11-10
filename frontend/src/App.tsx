import React, { useEffect, useState, useCallback } from 'react';
import { MediaItem, ServerStatus } from './types/media';
import { api } from './api/client';
import { NoiseOverlay } from './components/NoiseOverlay';
import { Header } from './components/Header';
import { MediaBrowser } from './components/MediaBrowser';
import { VideoPlayer } from './components/VideoPlayer';

export const App: React.FC = () => {
  const [view, setView] = useState<'browser' | 'player'>('browser');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  // Fetch initial catalog, server telemetry, and directory
  const loadData = useCallback(async () => {
    try {
      const items = await api.getMediaItems();
      setMediaItems(items);
    } catch {
      // Backend may be starting up or empty
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

    // Periodic telemetry ping every 10s
    const interval = setInterval(() => {
      api.getServerStatus()
        .then((s) => setServerStatus(s))
        .catch(() => {});
    }, 10000);

    return () => clearInterval(interval);
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
  };

  const handleBackToBrowser = () => {
    setView('browser');
    setSelectedItem(null);
  };

  return (
    <div className="app-container">
      {/* Global Grainy SVG Terminal Noise Overlay */}
      <NoiseOverlay />

      {/* Brutalist Header */}
      <Header
        serverStatus={serverStatus}
        selectedDirectory={selectedDirectory}
        onSelectDirectory={handleSelectDirectory}
        isScanning={isScanning}
      />

      {/* Main View Area */}
      <main className="app-main">
        {errorNotice && (
          <div
            style={{
              border: '2px solid #FFFFFF',
              background: '#000000',
              padding: '12px 16px',
              marginBottom: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
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

        {view === 'browser' ? (
          <MediaBrowser
            items={mediaItems}
            onSelectItem={handleSelectItem}
            onTriggerScan={() => handleSelectDirectory()}
            isScanning={isScanning}
          />
        ) : selectedItem ? (
          <VideoPlayer
            item={selectedItem}
            serverStatus={serverStatus}
            onBack={handleBackToBrowser}
          />
        ) : null}
      </main>
    </div>
  );
};
export default App;
