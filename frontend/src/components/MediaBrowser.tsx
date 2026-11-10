import React, { useState, useMemo, useEffect } from 'react';
import { MediaItem } from '../types/media';
import { MediaCard } from './MediaCard';
import { api } from '../api/client';

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
  onSelectItem,
  onTriggerScan,
  isScanning,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCodec, setFilterCodec] = useState('ALL');
  const [currentFolder, setCurrentFolder] = useState<string>('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);

  const effectiveRoot = useMemo(
    () => resolveEffectiveRoot(items, rootDirectory),
    [items, rootDirectory]
  );

  // Reset to root folder when the scanned library root changes
  useEffect(() => {
    setCurrentFolder('');
  }, [effectiveRoot]);

  const isSearching = searchQuery.trim().length > 0;

  // Build top-level & nested folder tree for the collapsible sidebar
  const allFolders = useMemo(() => {
    const map = new Map<string, { path: string; label: string; depth: number; count: number }>();
    for (const item of items) {
      const rel = getRelativeFolderPath(item.file_path, effectiveRoot);
      if (!rel) continue;
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
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => naturalCollator.compare(a.path, b.path));
  }, [items, effectiveRoot]);

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
      return {
        childFolders: [] as { name: string; fullRelPath: string; count: number }[],
        currentFiles: sorted,
      };
    }

    const folderCounts = new Map<
      string,
      { displayName: string; fullRelPath: string; count: number }
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
          {allFolders.length > 0 && (
            <button
              type="button"
              className={`brutalist-btn sm ${sidebarOpen ? 'active' : ''}`}
              onClick={() => setSidebarOpen((v) => !v)}
              title="Toggle Folder Tree Sidebar"
            >
              [DIRS: {sidebarOpen ? 'HIDE' : 'SHOW'}]
            </button>
          )}
          <span style={{ fontWeight: 900 }}>[FILTER]:</span>
          <input
            type="text"
            className="search-input"
            placeholder="SEARCH BY FILE NAME..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="toolbar-controls-group">
          <span style={{ fontSize: '0.78rem', fontWeight: 700 }}>[CODEC]:</span>
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

          <span style={{ fontSize: '0.78rem', fontWeight: 700, marginLeft: '4px' }}>[VIEW]:</span>
          <button
            type="button"
            className={`brutalist-btn sm ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
          >
            [GRID]
          </button>
          <button
            type="button"
            className={`brutalist-btn sm ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            [LIST]
          </button>

          <span className="badge badge-inverted">
            COUNT: {filteredItems.length} / {items.length}
          </span>
        </div>
      </div>

      {/* Folder Breadcrumb Bar */}
      {items.length > 0 && !isSearching && (
        <div className="breadcrumb-bar">
          <div className="breadcrumb-trail">
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

      {/* Industrial Terminal Workspace: Collapsible Folder Sidebar + Fluid Content Area */}
      <div className="browser-workspace">
        {allFolders.length > 0 && sidebarOpen && !isSearching && (
          <aside className="folder-sidebar" aria-label="Directory Tree">
            <div className="folder-sidebar-header">
              <span>[DIRECTORY TREE]</span>
              <span className="badge">{allFolders.length}</span>
            </div>
            <div className="folder-tree-list">
              <button
                type="button"
                className={`folder-tree-item ${currentFolder === '' ? 'active' : ''}`}
                onClick={() => setCurrentFolder('')}
              >
                <span>[ROOT] /</span>
                <span className="badge">{items.length}</span>
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
                  title={f.path}
                >
                  <span className="folder-tree-label">
                    {f.depth > 0 ? '└ ' : '▸ '}
                    {f.label}
                  </span>
                  <span className="badge">{f.count}</span>
                </button>
              ))}
            </div>
          </aside>
        )}

        <div className="browser-content-pane">
          {childFolders.length > 0 || currentFiles.length > 0 ? (
            viewMode === 'grid' ? (
              <div className="media-grid">
                {/* Folders First (sorted in natural order) */}
                {childFolders.map((folder) => (
                  <div
                    key={`folder:${folder.fullRelPath}`}
                    className="media-card folder-card"
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
                        <div
                          className="poster-fallback-ascii"
                          style={{ fontSize: '2.4rem', fontWeight: 900 }}
                        >
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
                      <div className="media-list-title">[FOLDER] {folder.name}</div>
                      <div className="media-list-sub">PATH: /{folder.fullRelPath}</div>
                    </div>
                    <div className="media-list-meta">
                      <span className="badge badge-inverted">DIRECTORY</span>
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
                        <div className="media-list-sub">{size}</div>
                      </div>
                      <div className="media-list-meta">
                        <span className="badge badge-inverted">[{res}]</span>
                        <span className="badge">[{dur}]</span>
                        <span className="badge">[{codec}]</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
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
      </div>

      {/* Sticky Mobile/Tablet Bottom Quick-Navigation Bar */}
      {items.length > 0 && (
        <nav className="mobile-bottom-bar" aria-label="Quick Navigation">
          <button
            type="button"
            className={`brutalist-btn sm ${currentFolder === '' ? 'active' : ''}`}
            onClick={() => setCurrentFolder('')}
          >
            [ROOT]
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
              [DIRS ({allFolders.length})]
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
