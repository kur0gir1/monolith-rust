export interface AudioTrack {
  index: number;
  codec: string;
  channels: number;
  channel_layout?: string | null;
  language?: string | null;
  title?: string | null;
}

export interface SubtitleTrack {
  index: number;
  codec: string;
  language?: string | null;
  title?: string | null;
  is_default: boolean;
  is_forced: boolean;
  is_bitmap: boolean;
}

export interface ChapterMarker {
  start: number;
  end: number;
  title?: string | null;
  kind?: 'intro' | 'outro' | null;
}

export interface MediaMetadata {
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  bitrate_kbps?: number | null;
  audio_tracks: AudioTrack[];
  subtitle_tracks: SubtitleTrack[];
}

export interface MediaItem {
  id: string;
  file_path: string;
  file_name: string;
  file_size_bytes: number;
  extension: string;
  metadata?: MediaMetadata | null;
  poster_path?: string | null;
}

export interface TunnelStatus {
  active: boolean;
  status: string; // "OFFLINE" | "CONNECTING" | "ONLINE" | "ERROR"
  provider: string;
  public_url?: string | null;
  invite_token: string;
  invite_url?: string | null;
  error?: string | null;
}

export interface PartyState {
  enabled: boolean;
  media_id?: string | null;
  media_title?: string | null;
  is_playing: boolean;
  current_time: number;
  audio_track: number;
  subtitle_track?: number | null;
  updated_at_ms: number;
  event_seq: number;
  updated_by: string;
  active_peers: number;
}

export interface ServerStatus {
  lan_ip: string;
  port: number;
  gpu_available: boolean;
  transcoder: string; // "NVENC CUDA" or "CPU LIBX264"
  selected_directory?: string | null;
  tunnel?: TunnelStatus;
}

export interface ScanResult {
  status: string;
  count: number;
}
