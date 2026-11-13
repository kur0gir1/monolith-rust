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
    if (!item.metadata || !item.metadata.height) return 'UNK';
    const h = item.metadata.height;
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440P';
    if (h >= 1080) return '1080P';
    if (h >= 720) return '720P';
    if (h >= 480) return '480P';
    return `${h}P`;
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
        {watchedPercent > 0 && (
          <div
            className="card-top-right-badge watched-active"
            title={`${watchedPercent}% watched`}
          >
            [{watchedPercent}% WATCHED]
          </div>
        )}

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
            <svg
              className="poster-fallback-sigil"
              viewBox="0 0 48 48"
              width="38"
              height="38"
              aria-hidden="true"
            >
              <path
                d="M24 2 L27 19 L46 24 L27 29 L24 46 L21 29 L2 24 L21 19 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <polygon points="20,18 32,24 20,30" fill="currentColor" />
              <circle cx="24" cy="24" r="14" fill="none" stroke="currentColor" strokeWidth="0.7" strokeDasharray="2 2" />
            </svg>
            <span style={{ fontSize: '0.78rem', fontWeight: 700, marginTop: '6px' }}>
              [{item.extension.toUpperCase()}]
            </span>
            <span style={{ fontSize: '0.68rem', marginTop: '3px', opacity: 0.72 }}>
              {getFileSizeString()}
            </span>
          </div>
        )}

        {watchedPercent > 0 && (
          <div className="card-progress-bar" aria-hidden="true">
            <div
              className="card-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, watchedPercent))}%` }}
            />
          </div>
        )}
      </div>

      <div className="media-card-content">
        <div className="media-card-title" title={item.file_name}>
          {item.file_name}
        </div>

        <div className="media-card-badges">
          <span className="badge badge-inverted">{getResolutionBadge()}</span>
          <span className="badge">{getDurationString()}</span>
          <span className="badge">{codec}</span>
          <span className="badge">{audioCount}A/{subCount}S</span>
        </div>
      </div>
    </div>
  );
};
