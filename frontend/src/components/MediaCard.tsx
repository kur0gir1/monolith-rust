import React, { useState } from 'react';
import { MediaItem } from '../types/media';
import { api } from '../api/client';

interface MediaCardProps {
  item: MediaItem;
  watchedPercent?: number;
  onSelect: (item: MediaItem) => void;
}

export const MediaCard: React.FC<MediaCardProps> = ({
  item,
  watchedPercent = 0,
  onSelect,
}) => {
  const [imageFailed, setImageFailed] = useState(false);

  // Format resolution badge
  const getResolutionBadge = (): string => {
    if (!item.metadata || !item.metadata.height) return '[RES: UNKNOWN]';
    const h = item.metadata.height;
    if (h >= 2160) return '[4K UHD]';
    if (h >= 1440) return '[1440P QHD]';
    if (h >= 1080) return '[1080P FHD]';
    if (h >= 720) return '[720P HD]';
    if (h >= 480) return '[480P SD]';
    return `[${h}P]`;
  };

  // Format duration
  const getDurationString = (): string => {
    if (!item.metadata || !item.metadata.duration_seconds) return '--:--';
    const totalSecs = Math.floor(item.metadata.duration_seconds);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Format file size
  const getFileSizeString = (): string => {
    const bytes = item.file_size_bytes;
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const audioCount = item.metadata?.audio_tracks?.length ?? 0;
  const subCount = item.metadata?.subtitle_tracks?.length ?? 0;
  const codec = item.metadata?.video_codec?.toUpperCase() || item.extension.toUpperCase();
  const posterUrl = api.getPosterUrl(item.id);

  return (
    <div
      className="media-card"
      onClick={() => onSelect(item)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelect(item);
        }
      }}
    >
      <div className="media-card-poster-wrapper">
        <div
          className={`card-top-right-badge ${watchedPercent > 0 ? 'watched-active' : ''}`}
          title={`${watchedPercent}% watched`}
        >
          [{watchedPercent}% WATCHED]
        </div>

        {!imageFailed ? (
          <img
            src={posterUrl}
            alt={item.file_name}
            className="media-card-poster"
            onError={() => setImageFailed(true)}
            loading="lazy"
          />
        ) : (
          <div className="media-card-poster-fallback">
            <span className="poster-fallback-ascii">▶ // ❚❚</span>
            <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>
              [{item.extension.toUpperCase()}]
            </span>
            <span style={{ fontSize: '0.7rem', marginTop: '6px', opacity: 0.72 }}>
              {getFileSizeString()}
            </span>
          </div>
        )}

        <div className="card-progress-bar" aria-hidden="true">
          <div
            className="card-progress-fill"
            style={{ width: `${Math.min(100, Math.max(0, watchedPercent))}%` }}
          />
        </div>
      </div>

      <div className="media-card-content">
        <div className="media-card-title" title={item.file_name}>
          {item.file_name}
        </div>

        <div className="media-card-badges">
          <span className="badge badge-inverted">{getResolutionBadge()}</span>
          <span className="badge">[{getDurationString()}]</span>
          <span className="badge">[{codec}]</span>
          <span className="badge">[AUDIO: {audioCount}]</span>
          <span className="badge">[SUBS: {subCount}]</span>
        </div>
      </div>
    </div>
  );
};
