import { ChapterMarker, MediaItem, PartyState, ServerStatus, TunnelStatus } from '../types/media';

const INVITE_STORAGE_KEY = 'monolith_invite_token_v1';
const PEER_ID_STORAGE_KEY = 'monolith_peer_id_v1';

// Capture `?invite=<token>` from URL query string if present and persist in storage + cookie
export function getOrCaptureInviteToken(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const params = new URLSearchParams(window.location.search);
    const urlInvite = params.get('invite');
    if (urlInvite && urlInvite.trim().length > 0) {
      const clean = urlInvite.trim();
      localStorage.setItem(INVITE_STORAGE_KEY, clean);
      document.cookie = `monolith_invite=${encodeURIComponent(clean)}; path=/; SameSite=Lax`;
      return clean;
    }

    const saved = localStorage.getItem(INVITE_STORAGE_KEY);
    if (saved && saved.trim().length > 0) {
      document.cookie = `monolith_invite=${encodeURIComponent(saved.trim())}; path=/; SameSite=Lax`;
      return saved.trim();
    }
  } catch {
    // ignore storage errors
  }

  return null;
}

export function setInviteTokenManual(token: string) {
  if (typeof window === 'undefined') return;
  const clean = token.trim();
  try {
    localStorage.setItem(INVITE_STORAGE_KEY, clean);
    document.cookie = `monolith_invite=${encodeURIComponent(clean)}; path=/; SameSite=Lax`;
  } catch {
    // ignore
  }
}

export function getPeerId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    let pid = localStorage.getItem(PEER_ID_STORAGE_KEY);
    if (!pid) {
      pid = 'peer-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(PEER_ID_STORAGE_KEY, pid);
    }
    return pid;
  } catch {
    return 'peer-anon';
  }
}

// Dynamically detect Tauri environment
export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isRemoteTunnelClient(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname.toLowerCase();
  return (
    h.includes('.lhr.life') ||
    h.includes('.trycloudflare.com') ||
    h.includes('.serveo.net') ||
    h.includes('.serveousercontent.com')
  );
}

// Compute the base URL for Axum REST and streaming endpoints
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:9000';
  }
  const origin = window.location.origin;
  if (
    origin.startsWith('tauri://') ||
    origin.includes('tauri.localhost') ||
    window.location.port === '5173'
  ) {
    return 'http://127.0.0.1:9000';
  }
  return '';
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const invite = getOrCaptureInviteToken();
  if (invite) {
    headers['x-monolith-invite'] = invite;
  }
  return headers;
}

function appendInviteParam(url: string): string {
  const invite = getOrCaptureInviteToken();
  if (!invite) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}invite=${encodeURIComponent(invite)}`;
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? getApiBaseUrl();
    getOrCaptureInviteToken();
  }

  public setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  async selectAndScanDirectory(path?: string): Promise<MediaItem[]> {
    if (isTauriEnvironment()) {
      try {
        return await tauriInvoke<MediaItem[]>('select_and_scan_directory', { path });
      } catch (err) {
        console.warn('Tauri select_and_scan_directory failed, falling back to REST:', err);
      }
    }

    const res = await fetch(`${this.baseUrl}/api/scan`, {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: path || null }),
    });

    if (!res.ok) {
      throw new Error(`Failed to scan directory: HTTP ${res.status}`);
    }

    return this.getMediaItems();
  }

  async getMediaItems(): Promise<MediaItem[]> {
    if (isTauriEnvironment()) {
      try {
        const items = await tauriInvoke<MediaItem[]>('get_media_items');
        return items ?? [];
      } catch (err) {
        console.warn('Tauri get_media_items failed, falling back to REST:', err);
      }
    }

    const res = await fetch(appendInviteParam(`${this.baseUrl}/api/media`), {
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED_INVITE');
      }
      throw new Error(`Failed to fetch media catalog: HTTP ${res.status}`);
    }
    return res.json();
  }

  async getMediaItem(id: string): Promise<MediaItem | null> {
    if (isTauriEnvironment()) {
      try {
        return await tauriInvoke<MediaItem | null>('get_media_item', { id });
      } catch (err) {
        console.warn('Tauri get_media_item failed, falling back to REST:', err);
      }
    }

    const res = await fetch(
      appendInviteParam(`${this.baseUrl}/api/media/${encodeURIComponent(id)}`),
      { headers: buildAuthHeaders() }
    );
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`Failed to fetch media item ${id}: HTTP ${res.status}`);
    }
    return res.json();
  }

  async getSelectedDirectory(): Promise<string | null> {
    if (isTauriEnvironment()) {
      try {
        const dir = await tauriInvoke<string | null>('get_selected_directory');
        if (dir) return dir;
      } catch (err) {
        console.warn('Tauri get_selected_directory failed:', err);
      }
    }
    try {
      const status = await this.getServerStatus();
      return status.selected_directory ?? null;
    } catch {
      return null;
    }
  }

  async getServerStatus(): Promise<ServerStatus> {
    const res = await fetch(appendInviteParam(`${this.baseUrl}/api/status`), {
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch server status: HTTP ${res.status}`);
    }
    return res.json();
  }

  getPosterUrl(id: string): string {
    return appendInviteParam(`${this.baseUrl}/api/media/${encodeURIComponent(id)}/poster`);
  }

  getMasterStreamUrl(id: string, audioIndex?: number): string {
    const query = audioIndex !== undefined ? `?audio=${audioIndex}` : '';
    return appendInviteParam(
      `${this.baseUrl}/api/stream/${encodeURIComponent(id)}/master.m3u8${query}`
    );
  }

  async getChapters(id: string): Promise<ChapterMarker[]> {
    const res = await fetch(
      appendInviteParam(`${this.baseUrl}/api/media/${encodeURIComponent(id)}/chapters`),
      { headers: buildAuthHeaders() }
    );
    if (!res.ok) return [];
    return res.json();
  }

  getSubtitleUrl(id: string, subIndex: number): string {
    return appendInviteParam(
      `${this.baseUrl}/api/stream/${encodeURIComponent(id)}/subtitles/${subIndex}/subs.vtt`
    );
  }

  async switchAudioTrack(id: string, audioIndex: number): Promise<void> {
    const res = await fetch(
      appendInviteParam(`${this.baseUrl}/api/stream/${encodeURIComponent(id)}/audio`),
      {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ audio_index: audioIndex }),
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to switch audio track: HTTP ${res.status}`);
    }
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    const res = await fetch(`${this.baseUrl}/api/tunnel`, {
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch tunnel status: HTTP ${res.status}`);
    }
    return res.json();
  }

  async startTunnel(provider: string): Promise<TunnelStatus> {
    const res = await fetch(`${this.baseUrl}/api/tunnel/start`, {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ provider }),
    });
    if (!res.ok) {
      throw new Error(`Failed to start tunnel: HTTP ${res.status}`);
    }
    return res.json();
  }

  async stopTunnel(): Promise<TunnelStatus> {
    const res = await fetch(`${this.baseUrl}/api/tunnel/stop`, {
      method: 'POST',
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to stop tunnel: HTTP ${res.status}`);
    }
    return res.json();
  }

  async killTunnel(): Promise<TunnelStatus> {
    const res = await fetch(`${this.baseUrl}/api/tunnel/kill`, {
      method: 'POST',
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to kill tunnel: HTTP ${res.status}`);
    }
    try {
      await this.resetParty();
    } catch (err) {
      console.warn('Failed to reset party on kill tunnel:', err);
    }
    return res.json();
  }

  async resetParty(): Promise<PartyState> {
    const res = await fetch(appendInviteParam(`${this.baseUrl}/api/party/reset`), {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    });
    if (!res.ok) {
      throw new Error(`Failed to reset watch party: HTTP ${res.status}`);
    }
    return res.json();
  }

  async rotateTunnelToken(): Promise<TunnelStatus> {
    const res = await fetch(`${this.baseUrl}/api/tunnel/rotate`, {
      method: 'POST',
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to rotate invite token: HTTP ${res.status}`);
    }
    return res.json();
  }

  async leaveParty(): Promise<void> {
    const peerId = getPeerId();
    const endpoint = appendInviteParam(`${this.baseUrl}/api/party/leave`);
    const payload = JSON.stringify({ peer_id: peerId });

    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try {
        const blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon(endpoint, blob)) {
          return;
        }
      } catch {
        // fallback to fetch keepalive
      }
    }

    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: payload,
        keepalive: true,
      });
    } catch {
      // ignore beacon errors on unload
    }
  }

  async getPartyState(): Promise<PartyState> {
    const peerId = getPeerId();
    const res = await fetch(
      appendInviteParam(`${this.baseUrl}/api/party?peer_id=${encodeURIComponent(peerId)}`),
      { headers: buildAuthHeaders() }
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch watch party state: HTTP ${res.status}`);
    }
    return res.json();
  }

  async updatePartyState(patch: {
    enabled?: boolean;
    media_id?: string;
    media_title?: string;
    is_playing?: boolean;
    current_time?: number;
    audio_track?: number;
    subtitle_track?: number | null;
  }): Promise<PartyState> {
    const res = await fetch(appendInviteParam(`${this.baseUrl}/api/party`), {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        peer_id: getPeerId(),
        ...patch,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to update watch party state: HTTP ${res.status}`);
    }
    return res.json();
  }

  async openUrlInBrowser(url: string): Promise<void> {
    if (isTauriEnvironment()) {
      try {
        await fetch(`${this.baseUrl}/api/open-browser`, {
          method: 'POST',
          headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ url }),
        });
        return;
      } catch {
        // fallback to window.open
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export const api = new ApiClient();
