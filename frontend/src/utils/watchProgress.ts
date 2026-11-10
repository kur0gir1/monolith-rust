export interface VideoProgressEntry {
  percent: number; // 0..100
  currentTime: number;
  duration: number;
  updatedAt: number;
}

export type WatchProgressMap = Record<string, VideoProgressEntry>;

const STORAGE_KEY = 'monolith_watch_progress_v1';

export function loadWatchProgress(): WatchProgressMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as WatchProgressMap;
    }
  } catch {
    // ignore storage errors
  }
  return {};
}

export function updateVideoProgressMap(
  prev: WatchProgressMap,
  mediaId: string,
  currentTime: number,
  duration: number
): WatchProgressMap {
  if (!mediaId || !Number.isFinite(currentTime) || currentTime <= 1) return prev;
  const effDur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (effDur <= 0) return prev;

  const rawPercent = Math.min(100, Math.max(0, Math.round((currentTime / effDur) * 100)));
  const percent = rawPercent >= 96 ? 100 : rawPercent;

  const prevEntry = prev[mediaId];
  if (
    prevEntry &&
    prevEntry.percent === percent &&
    Math.abs(prevEntry.currentTime - currentTime) < 2
  ) {
    return prev;
  }

  const next: WatchProgressMap = {
    ...prev,
    [mediaId]: {
      percent,
      currentTime,
      duration: effDur,
      updatedAt: Date.now(),
    },
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }

  return next;
}
