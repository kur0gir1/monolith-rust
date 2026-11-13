import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { MediaItem } from '../types/media';
import { MediaCard } from './MediaCard';
import { api } from '../api/client';
import { WatchProgressMap } from '../utils/watchProgress';

interface MediaBrowserProps {
  items: MediaItem[];
  rootDirectory?: string | null;
  watchProgress: WatchProgressMap;
  onSelectItem: (item: MediaItem) => void;
  onTriggerScan: () => void;
  onRefresh?: () => void;
  isScanning: boolean;
  isGuest?: boolean;
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

interface FolderEntry {
  name: string;
  fullRelPath: string;
  count: number;
  watchedPercent: number;
  previewMediaId: string;
}

const FolderPosterCard: React.FC<{
  folder: FolderEntry;
  onOpen: (path: string) => void;
}> = ({ folder, onOpen }) => {
  const [imgError, setImgError] = useState(false);

  return (
    <div
      className="media-card folder-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(folder.fullRelPath)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(folder.fullRelPath);
        }
      }}
      title={`${folder.name} (${folder.count} items${folder.watchedPercent > 0 ? `, ${folder.watchedPercent}% watched` : ''})`}
    >
      <div className="media-card-poster-wrapper">
        {folder.previewMediaId && !imgError ? (
          <img
            src={api.getPosterUrl(folder.previewMediaId)}
            alt={folder.name}
            className="media-card-poster"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="media-card-poster-fallback">
            <span className="poster-fallback-ascii">◈</span>
            <span style={{ fontSize: '0.875rem', fontWeight: 700, marginTop: '6px' }}>
              [DIRECTORY]
            </span>
          </div>
        )}

        <div className="card-top-right-badge">
          {folder.watchedPercent > 0 ? `${folder.watchedPercent}% · ` : ''}DIR · {folder.count}
        </div>

        {folder.watchedPercent > 0 && (
          <div
            className="card-progress-bar"
            aria-label={`${folder.watchedPercent}% watched`}
          >
            <div
              className="card-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, folder.watchedPercent))}%` }}
            />
          </div>
        )}
      </div>

      <div className="media-card-content">
        <h3 className="media-card-title">{folder.name}</h3>
        <div className="folder-card-sub">
          <span>
            {folder.count} {folder.count === 1 ? 'ITEM' : 'ITEMS'}
          </span>
          {folder.watchedPercent > 0 && <span>{folder.watchedPercent}% WATCHED</span>}
        </div>
      </div>
    </div>
  );
};

const IGNORED_FOLDER_SEGMENTS = new Set([
  'tests',
  'test',
  'fixtures',
  'target',
  'node_modules',
  '.git',
  '.cache',
  'dist',
  'build',
]);

function isIgnoredPath(relPath: string): boolean {
  if (!relPath) return false;
  const parts = relPath.toLowerCase().split(/[\\/]/);
  return parts.some((p) => IGNORED_FOLDER_SEGMENTS.has(p) || p.startsWith('.'));
}

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

function formatDurationShort(secs?: number | null): string {
  if (!secs || secs <= 0) return '--:--';
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatFileSizeShort(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MediaBrowser: React.FC<MediaBrowserProps> = ({
  items,
  rootDirectory,
  watchProgress,
  onSelectItem,
  onTriggerScan,
  onRefresh,
  isScanning,
  isGuest = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCodec, setFilterCodec] = useState('ALL');
  const [currentFolder, setCurrentFolder] = useState<string>('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth > 900 : true
  );

  const effectiveRoot = useMemo(
    () => resolveEffectiveRoot(items, rootDirectory),
    [items, rootDirectory]
  );

  // Reset to root folder when the scanned library root changes
  useEffect(() => {
    setCurrentFolder('');
  }, [effectiveRoot]);

  const isSearching = searchQuery.trim().length > 0;

  // Compute average % watched for any directory (empty string = root across all items)
  const getFolderWatchedPercent = useCallback(
    (folderRelPath: string): number => {
      if (items.length === 0) return 0;
      const targetLower = folderRelPath.toLowerCase();
      const matching =
        targetLower === ''
          ? items
          : items.filter((it) => {
              const rel = getRelativeFolderPath(it.file_path, effectiveRoot).toLowerCase();
              return rel === targetLower || rel.startsWith(targetLower + '/');
            });

      if (matching.length === 0) return 0;
      const total = matching.reduce(
        (sum, it) => sum + (watchProgress[it.id]?.percent ?? 0),
        0
      );
      return Math.round(total / matching.length);
    },
    [items, effectiveRoot, watchProgress]
  );

  const rootWatchedPercent = useMemo(
    () => getFolderWatchedPercent(''),
    [getFolderWatchedPercent]
  );

  const currentFolderWatchedPercent = useMemo(
    () => getFolderWatchedPercent(currentFolder),
    [getFolderWatchedPercent, currentFolder]
  );

  // Build top-level & nested folder tree for the collapsible sidebar
  const allFolders = useMemo(() => {
    const map = new Map<
      string,
      { path: string; label: string; depth: number; count: number; watchedPercent: number }
    >();
    for (const item of items) {
      const rel = getRelativeFolderPath(item.file_path, effectiveRoot);
      if (!rel || isIgnoredPath(rel)) continue;
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const subPath = parts.slice(0, i + 1).join('/');
        const key = subPath.toLowerCase();
        const existing = map.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(key, {
            path: subPath,
            label: parts[i],
            depth: i,
            count: 1,
            watchedPercent: 0,
          });
        }
      }
    }
    return Array.from(map.values())
      .map((f) => ({
        ...f,
        watchedPercent: getFolderWatchedPercent(f.path),
      }))
      .sort((a, b) => naturalCollator.compare(a.path, b.path));
  }, [items, effectiveRoot, getFolderWatchedPercent]);

  // Filter items by codec and search query
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const rel = getRelativeFolderPath(item.file_path, effectiveRoot);
      if (isIgnoredPath(rel)) return false;

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
  }, [items, effectiveRoot, searchQuery, filterCodec]);

  // Compute immediate child folders and files for the current folder view
  const { childFolders, currentFiles } = useMemo(() => {
    if (isSearching) {
      const sorted = [...filteredItems].sort((a, b) =>
        naturalCollator.compare(a.file_name, b.file_name)
      );
      return {
        childFolders: [] as FolderEntry[],
        currentFiles: sorted,
      };
    }

    const folderCounts = new Map<
      string,
      {
        displayName: string;
        fullRelPath: string;
        count: number;
        previewMediaId: string;
        previewMediaName: string;
      }
    >();
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
          if (naturalCollator.compare(item.file_name, existing.previewMediaName) < 0) {
            existing.previewMediaId = item.id;
            existing.previewMediaName = item.file_name;
          }
        } else {
          folderCounts.set(key, {
            displayName: firstSeg,
            fullRelPath: firstSeg,
            count: 1,
            previewMediaId: item.id,
            previewMediaName: item.file_name,
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
            if (naturalCollator.compare(item.file_name, existing.previewMediaName) < 0) {
              existing.previewMediaId = item.id;
              existing.previewMediaName = item.file_name;
            }
          } else {
            folderCounts.set(key, {
              displayName: nextSeg,
              fullRelPath: fullRel,
              count: 1,
              previewMediaId: item.id,
              previewMediaName: item.file_name,
            });
          }
        }
      }
    }

    const sortedFolders: FolderEntry[] = Array.from(folderCounts.values())
      .map((f) => ({
        name: f.displayName,
        fullRelPath: f.fullRelPath,
        count: f.count,
        watchedPercent: getFolderWatchedPercent(f.fullRelPath),
        previewMediaId: f.previewMediaId,
      }))
      .sort((a, b) => naturalCollator.compare(a.name, b.name));

    const sortedFiles = filesInFolder.sort((a, b) =>
      naturalCollator.compare(a.file_name, b.file_name)
    );

    return { childFolders: sortedFolders, currentFiles: sortedFiles };
  }, [filteredItems, currentFolder, effectiveRoot, isSearching, getFolderWatchedPercent]);

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
      {/* Unified Compact Cyber-Sigil Toolbar + Path Trail */}
      <div className="browser-toolbar">
        <div className="search-input-wrapper">
          {allFolders.length > 0 && (
            <button
              type="button"
              className={`brutalist-btn sm ${sidebarOpen ? 'active' : ''}`}
              onClick={() => setSidebarOpen((v) => !v)}
              title="Toggle Folders"
            >
              {isGuest ? `[FOLDERS (${allFolders.length})]` : `[✦ DIRS: ${sidebarOpen ? 'ON' : 'OFF'}]`}
            </button>
          )}
          {currentFolder && !isSearching && (
            <div className="breadcrumb-trail">
              <button
                type="button"
                className="brutalist-btn sm"
                onClick={handleGoUp}
                title="Go up one folder level"
              >
                [↑ UP]
              </button>
              <button
                type="button"
                className="brutalist-btn sm"
                onClick={() => setCurrentFolder('')}
              >
                {isGuest ? '[ALL]' : '[ROOT]'}
              </button>
              {breadcrumbs.map((crumb) => (
                <React.Fragment key={crumb.path}>
                  <span className="sigil-sep">/</span>
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
          )}
          <input
            type="text"
            className="search-input"
            placeholder={isGuest ? '⌖ SEARCH MOVIES & SHOWS...' : '⌖ FILTER CATALOG...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="toolbar-controls-group">
          {!isGuest &&
            ['ALL', 'H264', 'HEVC', 'MKV', 'MP4'].map((codec) => (
              <button
                key={codec}
                type="button"
                className={`brutalist-btn sm ${filterCodec === codec ? 'active' : ''}`}
                onClick={() => setFilterCodec(codec)}
              >
                [{codec}]
              </button>
            ))}

          <button
            type="button"
            className={`brutalist-btn sm ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
          >
            [⊞ GRID]
          </button>
          <button
            type="button"
            className={`brutalist-btn sm ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            [≡ LIST]
          </button>

          <span className="badge badge-inverted">
            {isGuest ? `${filteredItems.length} VIDEOS` : `${filteredItems.length}/${items.length}`}
          </span>
          {items.length > 0 && currentFolderWatchedPercent > 0 && (
            <span className="badge">
              {currentFolderWatchedPercent}% WATCHED
            </span>
          )}
        </div>
      </div>

      {/* Industrial Terminal Workspace: Collapsible Folder Sidebar + Fluid Content Area */}
      <div className="browser-workspace">
        {allFolders.length > 0 && sidebarOpen && !isSearching && (
          <aside className="folder-sidebar" aria-label="Directory Tree">
            <div className="folder-sidebar-header">
              <span>{isGuest ? '[FOLDERS]' : '[DIRECTORY TREE]'}</span>
              <span className="badge">{allFolders.length}</span>
            </div>
            <div className="folder-tree-list">
              <button
                type="button"
                className={`folder-tree-item ${currentFolder === '' ? 'active' : ''}`}
                onClick={() => setCurrentFolder('')}
              >
                <span className="folder-tree-label">{isGuest ? 'ALL LIBRARY' : '[ROOT] /'}</span>
                <span className="folder-tree-meta">
                  {rootWatchedPercent > 0 && (
                    <span className="folder-tree-pct">{rootWatchedPercent}%</span>
                  )}
                  <span className="folder-tree-count">{items.length}</span>
                </span>
              </button>
              {allFolders.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`folder-tree-item ${
                    currentFolder.toLowerCase() === f.path.toLowerCase() ? 'active' : ''
                  }`}
                  style={{ paddingLeft: `${12 + f.depth * 14}px` }}
                  onClick={() => setCurrentFolder(f.path)}
                  title={`${f.path}${f.watchedPercent > 0 ? ` (${f.watchedPercent}% watched)` : ''}`}
                >
                  <span className="folder-tree-label">
                    {f.depth > 0 ? '└ ' : '▸ '}
                    {f.label}
                  </span>
                  <span className="folder-tree-meta">
                    {f.watchedPercent > 0 && (
                      <span className="folder-tree-pct">{f.watchedPercent}%</span>
                    )}
                    <span className="folder-tree-count">{f.count}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>
        )}

        <div className="browser-content-pane">
          {childFolders.length > 0 || currentFiles.length > 0 ? (
            viewMode === 'grid' ? (
              currentFiles.length === 0 ? (
                /* Poster-backed Directory Cards when folder contains only subfolders */
                <div className="media-grid" aria-label="Directories">
                  {childFolders.map((folder) => (
                    <FolderPosterCard
                      key={`folder:${folder.fullRelPath}`}
                      folder={folder}
                      onOpen={setCurrentFolder}
                    />
                  ))}
                </div>
              ) : (
                <>
                  {/* Compact High-Density Directory Strip Tiles above mixed video posters */}
                  {childFolders.length > 0 && (
                    <div className="folder-strip-grid" aria-label="Subdirectories">
                      {childFolders.map((folder) => (
                        <button
                          key={`folder:${folder.fullRelPath}`}
                          type="button"
                          className="folder-strip-tile"
                          onClick={() => setCurrentFolder(folder.fullRelPath)}
                          title={`${folder.name} (${folder.count} items${folder.watchedPercent > 0 ? `, ${folder.watchedPercent}% watched` : ''})`}
                        >
                          <span className="folder-strip-icon" aria-hidden="true">◈</span>
                          <span className="folder-strip-name">{folder.name}</span>
                          <span className="folder-strip-meta">
                            {folder.watchedPercent > 0 && (
                              <span className="badge badge-inverted">{folder.watchedPercent}%</span>
                            )}
                            <span className="badge">{folder.count}</span>
                          </span>
                          {folder.watchedPercent > 0 && (
                            <span
                              className="folder-strip-progress"
                              style={{ width: `${Math.min(100, Math.max(0, folder.watchedPercent))}%` }}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Video Poster Grid */}
                  <div className="media-grid">
                    {currentFiles.map((item) => (
                      <MediaCard
                        key={item.id}
                        item={item}
                        watchedPercent={watchProgress[item.id]?.percent ?? 0}
                        isGuest={isGuest}
                        onSelect={onSelectItem}
                      />
                    ))}
                  </div>
                </>
              )
            ) : (
              /* Compact List View */
              <div className="media-list">
                {childFolders.map((folder) => (
                  <div
                    key={`folder-row:${folder.fullRelPath}`}
                    className="media-list-row folder-row"
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
                    <div className="media-list-thumb">[DIR]</div>
                    <div className="media-list-main">
                      <div className="media-list-title">
                        {isGuest ? folder.name : `[FOLDER] ${folder.name}`}
                      </div>
                      <div className="media-list-sub">
                        {isGuest ? `${folder.count} ITEMS` : `PATH: /${folder.fullRelPath}`}
                      </div>
                    </div>
                    <div className="media-list-meta">
                      {folder.watchedPercent > 0 && (
                        <span className="badge badge-inverted">
                          [{folder.watchedPercent}% WATCHED]
                        </span>
                      )}
                      <span className="badge">{folder.count} ITEMS</span>
                    </div>
                  </div>
                ))}

                {currentFiles.map((item, idx) => {
                  const codec =
                    item.metadata?.video_codec?.toUpperCase() || item.extension.toUpperCase();
                  const res = item.metadata?.height ? `${item.metadata.height}P` : 'UNK';
                  const dur = formatDurationShort(item.metadata?.duration_seconds);
                  const size = formatFileSizeShort(item.file_size_bytes);
                  const pct = watchProgress[item.id]?.percent ?? 0;
                  return (
                    <div
                      key={item.id}
                      className="media-list-row"
                      onClick={() => onSelectItem(item)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectItem(item);
                        }
                      }}
                    >
                      <div className="media-list-thumb">
                        <img
                          src={api.getPosterUrl(item.id)}
                          alt={item.file_name}
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                        <span>#{String(idx + 1).padStart(2, '0')}</span>
                      </div>
                      <div className="media-list-main">
                        <div className="media-list-title">{item.file_name}</div>
                        <div className="media-list-sub">{isGuest ? dur : size}</div>
                      </div>
                      <div className="media-list-meta">
                        {pct > 0 && (
                          <span className="badge badge-inverted">
                            [{pct}% WATCHED]
                          </span>
                        )}
                        <span className="badge">[{res}]</span>
                        <span className="badge">[{dur}]</span>
                        {!isGuest && <span className="badge">[{codec}]</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="empty-state">
              <h2 style={{ fontSize: '1.25rem', fontWeight: 900 }}>
                {items.length === 0
                  ? isGuest
                    ? '[NO VIDEOS SHARED YET]'
                    : '[NO MEDIA DISCOVERED IN CATALOG]'
                  : '[NO FILES MATCHING ACTIVE FILTER]'}
              </h2>
              <p style={{ fontSize: '0.9375rem', opacity: 0.85 }}>
                {items.length === 0
                  ? isGuest
                    ? 'Waiting for the host to add movies or shows to this library.'
                    : 'Click [◈ SCAN DIR] in the header to point Monolith to your local media folder (.mkv, .mp4, .webm, .avi).'
                  : 'Clear or adjust your search filter query above to display indexed media items.'}
              </p>
              {items.length === 0 && !isGuest && (
                <button
                  type="button"
                  className="brutalist-btn badge-inverted"
                  onClick={onTriggerScan}
                  disabled={isScanning}
                >
                  {isScanning ? '[SCANNING IN PROGRESS...]' : '[SCAN MEDIA DIRECTORY NOW]'}
                </button>
              )}
              {items.length === 0 && isGuest && onRefresh && (
                <button
                  type="button"
                  className="brutalist-btn badge-inverted"
                  onClick={onRefresh}
                >
                  [↻ REFRESH LIBRARY]
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sticky Mobile/Tablet Bottom Quick-Navigation Bar */}
      {items.length > 0 && (
        <nav className="mobile-bottom-bar" aria-label="Quick Navigation">
          <button
            type="button"
            className={`brutalist-btn sm ${currentFolder === '' ? 'active' : ''}`}
            onClick={() => setCurrentFolder('')}
          >
            {isGuest ? '[ALL]' : '[ROOT]'}
          </button>
          {currentFolder && (
            <button type="button" className="brutalist-btn sm" onClick={handleGoUp}>
              [.. UP]
            </button>
          )}
          {allFolders.length > 0 && (
            <button
              type="button"
              className={`brutalist-btn sm ${sidebarOpen ? 'active' : ''}`}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {isGuest ? `[FOLDERS (${allFolders.length})]` : `[DIRS (${allFolders.length})]`}
            </button>
          )}
          <button
            type="button"
            className="brutalist-btn sm"
            onClick={() => setViewMode((m) => (m === 'grid' ? 'list' : 'grid'))}
          >
            [{viewMode === 'grid' ? 'LIST VIEW' : 'GRID VIEW'}]
          </button>
        </nav>
      )}
    </div>
  );
};
