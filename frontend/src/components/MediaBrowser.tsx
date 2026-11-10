import React, { useState, useMemo, useEffect } from 'react';
import { MediaItem } from '../types/media';
import { MediaCard } from './MediaCard';

interface MediaBrowserProps {
  items: MediaItem[];
  rootDirectory?: string | null;
  onSelectItem: (item: MediaItem) => void;
  onTriggerScan: () => void;
  isScanning: boolean;
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function normalizeSlashes(p: string): string {
  return p
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Infers the common root directory across all media items if rootDirectory is not explicitly known.
 */
function resolveEffectiveRoot(items: MediaItem[], rootDirectory?: string | null): string {
  if (rootDirectory && rootDirectory.trim().length > 0) {
    return normalizeSlashes(rootDirectory.trim());
  }
  if (items.length === 0) return '';

  const splitDirs = items.map((item) => {
    const norm = normalizeSlashes(item.file_path);
    const lastSlash = norm.lastIndexOf('/');
    const parent = lastSlash >= 0 ? norm.slice(0, lastSlash) : '';
    return parent.split('/');
  });

  const first = splitDirs[0];
  let commonLen = first.length;
  for (let i = 1; i < splitDirs.length; i++) {
    const cur = splitDirs[i];
    let j = 0;
    while (j < commonLen && j < cur.length && first[j].toLowerCase() === cur[j].toLowerCase()) {
      j++;
    }
    commonLen = j;
  }

  return first.slice(0, commonLen).join('/');
}

/**
 * Computes the folder path of a media item relative to the root directory (e.g. "Season 1/Extras" or "").
 */
function getRelativeFolderPath(filePath: string, effectiveRoot: string): string {
  const normFile = normalizeSlashes(filePath);
  const lastSlash = normFile.lastIndexOf('/');
  const parentDir = lastSlash >= 0 ? normFile.slice(0, lastSlash) : '';

  if (!effectiveRoot) return '';
  if (parentDir.toLowerCase() === effectiveRoot.toLowerCase()) {
    return '';
  }
  if (parentDir.toLowerCase().startsWith(effectiveRoot.toLowerCase() + '/')) {
    return parentDir.slice(effectiveRoot.length + 1);
  }
  return '';
}

export const MediaBrowser: React.FC<MediaBrowserProps> = ({
  items,
  rootDirectory,
  onSelectItem,
  onTriggerScan,
  isScanning,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCodec, setFilterCodec] = useState('ALL');
  const [currentFolder, setCurrentFolder] = useState<string>('');

  const effectiveRoot = useMemo(
    () => resolveEffectiveRoot(items, rootDirectory),
    [items, rootDirectory]
  );

  // Reset to root folder when the scanned library root changes
  useEffect(() => {
    setCurrentFolder('');
  }, [effectiveRoot]);

  const isSearching = searchQuery.trim().length > 0;

  // Filter items by codec and search query
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

  // Compute immediate child folders and files for the current folder view
  const { childFolders, currentFiles } = useMemo(() => {
    if (isSearching) {
      const sorted = [...filteredItems].sort((a, b) =>
        naturalCollator.compare(a.file_name, b.file_name)
      );
      return { childFolders: [] as { name: string; fullRelPath: string; count: number }[], currentFiles: sorted };
    }

    const folderCounts = new Map<string, { displayName: string; fullRelPath: string; count: number }>();
    const filesInFolder: MediaItem[] = [];

    const prefix = currentFolder ? currentFolder + '/' : '';
    const prefixLower = prefix.toLowerCase();

    for (const item of filteredItems) {
      const relFolder = getRelativeFolderPath(item.file_path, effectiveRoot);
      const relLower = relFolder.toLowerCase();

      if (relLower === currentFolder.toLowerCase()) {
        filesInFolder.push(item);
      } else if (!currentFolder && relFolder.length > 0) {
        const firstSeg = relFolder.split('/')[0];
        const key = firstSeg.toLowerCase();
        const existing = folderCounts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          folderCounts.set(key, {
            displayName: firstSeg,
            fullRelPath: firstSeg,
            count: 1,
          });
        }
      } else if (currentFolder && relLower.startsWith(prefixLower)) {
        const remainder = relFolder.slice(prefix.length);
        const nextSeg = remainder.split('/')[0];
        if (nextSeg) {
          const key = nextSeg.toLowerCase();
          const fullRel = `${currentFolder}/${nextSeg}`;
          const existing = folderCounts.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            folderCounts.set(key, {
              displayName: nextSeg,
              fullRelPath: fullRel,
              count: 1,
            });
          }
        }
      }
    }

    const sortedFolders = Array.from(folderCounts.values())
      .map((f) => ({
        name: f.displayName,
        fullRelPath: f.fullRelPath,
        count: f.count,
      }))
      .sort((a, b) => naturalCollator.compare(a.name, b.name));

    const sortedFiles = filesInFolder.sort((a, b) =>
      naturalCollator.compare(a.file_name, b.file_name)
    );

    return { childFolders: sortedFolders, currentFiles: sortedFiles };
  }, [filteredItems, currentFolder, effectiveRoot, isSearching]);

  // Breadcrumb segments
  const breadcrumbs = useMemo(() => {
    if (!currentFolder) return [];
    const parts = currentFolder.split('/');
    return parts.map((part, idx) => ({
      name: part,
      path: parts.slice(0, idx + 1).join('/'),
    }));
  }, [currentFolder]);

  const handleGoUp = () => {
    if (!currentFolder) return;
    const lastSlash = currentFolder.lastIndexOf('/');
    setCurrentFolder(lastSlash >= 0 ? currentFolder.slice(0, lastSlash) : '');
  };

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

      {/* Folder Breadcrumb Bar */}
      {items.length > 0 && !isSearching && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
            border: '2px solid #FFFFFF',
            padding: '8px 14px',
            marginBottom: '20px',
            background: '#000000',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
            <span style={{ fontWeight: 900, marginRight: '4px' }}>[PATH]:</span>
            <button
              type="button"
              className={`brutalist-btn sm ${currentFolder === '' ? 'active' : ''}`}
              onClick={() => setCurrentFolder('')}
            >
              [ROOT]
            </button>
            {breadcrumbs.map((crumb) => (
              <React.Fragment key={crumb.path}>
                <span style={{ fontWeight: 900 }}>/</span>
                <button
                  type="button"
                  className={`brutalist-btn sm ${currentFolder === crumb.path ? 'active' : ''}`}
                  onClick={() => setCurrentFolder(crumb.path)}
                >
                  [{crumb.name}]
                </button>
              </React.Fragment>
            ))}
          </div>

          {currentFolder && (
            <button type="button" className="brutalist-btn sm" onClick={handleGoUp}>
              [.. UP ONE LEVEL]
            </button>
          )}
        </div>
      )}

      {/* Folders + Media Grid or Empty State */}
      {childFolders.length > 0 || currentFiles.length > 0 ? (
        <div className="media-grid">
          {/* Folders First (sorted in natural order) */}
          {childFolders.map((folder) => (
            <div
              key={`folder:${folder.fullRelPath}`}
              className="media-card"
              onClick={() => setCurrentFolder(folder.fullRelPath)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setCurrentFolder(folder.fullRelPath);
                }
              }}
            >
              <div className="media-card-poster-wrapper">
                <div className="media-card-poster-fallback">
                  <div className="poster-fallback-ascii" style={{ fontSize: '2.5rem', fontWeight: 900 }}>
                    [DIR]
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.85 }}>
                    {folder.count} {folder.count === 1 ? 'ITEM' : 'ITEMS'}
                  </div>
                </div>
              </div>
              <div className="media-card-content">
                <div className="media-card-title">[FOLDER] {folder.name}</div>
                <div className="media-card-badges">
                  <span className="badge badge-inverted">DIRECTORY</span>
                  <span className="badge">{folder.count} MEDIA</span>
                </div>
              </div>
            </div>
          ))}

          {/* Files Second (sorted in natural order) */}
          {currentFiles.map((item) => (
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
