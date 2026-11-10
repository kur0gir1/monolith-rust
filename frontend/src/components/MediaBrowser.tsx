import React, { useState, useMemo } from 'react';
import { MediaItem } from '../types/media';
import { MediaCard } from './MediaCard';

interface MediaBrowserProps {
  items: MediaItem[];
  onSelectItem: (item: MediaItem) => void;
  onTriggerScan: () => void;
  isScanning: boolean;
}

export const MediaBrowser: React.FC<MediaBrowserProps> = ({
  items,
  onSelectItem,
  onTriggerScan,
  isScanning,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCodec, setFilterCodec] = useState('ALL');

  // Filter items by search query and optional codec
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchesSearch = item.file_name
        .toLowerCase()
        .includes(searchQuery.toLowerCase().trim());
      const codec = item.metadata?.video_codec?.toLowerCase() || '';
      const matchesCodec =
        filterCodec === 'ALL' ||
        codec.includes(filterCodec.toLowerCase()) ||
        item.extension.toLowerCase() === filterCodec.toLowerCase();

      return matchesSearch && matchesCodec;
    });
  }, [items, searchQuery, filterCodec]);

  return (
    <div className="browser-container">
      {/* Toolbar */}
      <div className="browser-toolbar">
        <div className="search-input-wrapper">
          <span style={{ fontWeight: 900 }}>[FILTER]:</span>
          <input
            type="text"
            className="search-input"
            placeholder="SEARCH BY FILE NAME..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>[CODEC]:</span>
          {['ALL', 'H264', 'HEVC', 'MKV', 'MP4'].map((codec) => (
            <button
              key={codec}
              type="button"
              className={`brutalist-btn sm ${filterCodec === codec ? 'active' : ''}`}
              onClick={() => setFilterCodec(codec)}
            >
              [{codec}]
            </button>
          ))}
          <span className="badge badge-inverted">
            COUNT: {filteredItems.length} / {items.length}
          </span>
        </div>
      </div>

      {/* Media Grid or Empty State */}
      {filteredItems.length > 0 ? (
        <div className="media-grid">
          {filteredItems.map((item) => (
            <MediaCard key={item.id} item={item} onSelect={onSelectItem} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <h2 style={{ fontSize: '1.2rem', fontWeight: 900 }}>
            {items.length === 0
              ? '[NO MEDIA DISCOVERED IN CATALOG]'
              : '[NO FILES MATCHING ACTIVE FILTER]'}
          </h2>
          <p style={{ fontSize: '0.85rem', opacity: 0.8 }}>
            {items.length === 0
              ? 'Click [SELECT ROOT DIRECTORY] in the header to point Monolith to your local media folder (.mkv, .mp4, .webm, .avi).'
              : 'Clear or adjust your search filter query above to display indexed media items.'}
          </p>
          {items.length === 0 && (
            <button
              type="button"
              className="brutalist-btn badge-inverted"
              onClick={onTriggerScan}
              disabled={isScanning}
            >
              {isScanning ? '[SCANNING IN PROGRESS...]' : '[SCAN MEDIA DIRECTORY NOW]'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
