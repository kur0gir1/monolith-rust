import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import { ChapterMarker, MediaItem, PartyState, ServerStatus, AudioTrack, SubtitleTrack } from '../types/media';
import { api, getOrCaptureInviteToken, getPeerId, isHostClient } from '../api/client';
import { VideoProgressEntry, WatchProgressMap } from '../utils/watchProgress';

interface VideoPlayerProps {
  item: MediaItem;
  serverStatus: ServerStatus | null;
  partyState?: PartyState | null;
  initialProgress?: VideoProgressEntry;
  onProgressUpdate?: (mediaId: string, currentTime: number, duration: number) => void;
  onBack: () => void;
  /** Episodes in the same folder (natural order). Sidebar shows when there is more than one. */
  playlist?: MediaItem[];
  watchProgress?: WatchProgressMap;
  onSelectItem?: (item: MediaItem) => void;
}

const AUTO_NEXT_STORAGE_KEY = 'monolith_auto_next_v1';

interface SubtitleSettings {
  fontSize: number; // rem (e.g. 1.0 to 2.4)
  textColor: string; // '#FFFFFF' | '#FFFF00' | '#00FFFF' | '#00FF66'
  bgOpacity: number; // 0 to 1
  bottomOffset: number; // % from bottom (e.g. 8 to 28)
  outline: boolean;
}

const DEFAULT_SUB_SETTINGS: SubtitleSettings = {
  fontSize: 1.35,
  textColor: '#FFFFFF',
  bgOpacity: 0.75,
  bottomOffset: 12,
  outline: true,
};

const SUB_SETTINGS_STORAGE_KEY = 'monolith_subtitle_settings_v1';

function loadSubtitleSettings(): SubtitleSettings {
  try {
    const raw = localStorage.getItem(SUB_SETTINGS_STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_SUB_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_SUB_SETTINGS;
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '00:00';
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
      .toString()
      .padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function isLocalTimeSeekable(video: HTMLVideoElement, localSec: number): boolean {
  if (!Number.isFinite(localSec) || localSec < 0) return false;
  for (let i = 0; i < video.seekable.length; i++) {
    if (localSec >= video.seekable.start(i) && localSec <= video.seekable.end(i)) {
      return true;
    }
  }
  return false;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  item,
  serverStatus,
  partyState,
  initialProgress,
  onProgressUpdate,
  onBack,
  playlist = [],
  watchProgress = {},
  onSelectItem,
}) => {
  const currentIndex = playlist.findIndex((p) => p.id === item.id);
  const nextItem = currentIndex >= 0 ? playlist[currentIndex + 1] ?? null : null;
  const showPlaylist = playlist.length > 1;
  const [chapters, setChapters] = useState<ChapterMarker[]>([]);
  const [playlistOpen, setPlaylistOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth > 900 && window.innerHeight > 540 : true
  );
  const [autoNext, setAutoNext] = useState<boolean>(
    () => localStorage.getItem(AUTO_NEXT_STORAGE_KEY) !== 'false'
  );
  const autoNextTriggeredRef = useRef<boolean>(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const streamOffsetRef = useRef<number>(0);
  const pendingSeekTimerRef = useRef<number | null>(null);
  const isStreamReadyRef = useRef<boolean>(false);
  const streamReadyAtRef = useRef<number>(0);
  const streamGenRef = useRef<number>(0);
  const autoplayBlockedRef = useRef<boolean>(false);
  const lastSeekRestartAtRef = useRef<number>(0);
  const lastRemoteApplyAtRef = useRef<number>(0);
  const lastHudUpdateAtRef = useRef<number>(0);
  const lastProgressSaveAtRef = useRef<number>(0);
  const desirePlayingRef = useRef<boolean | null>(null);
  const autoplayMutedRef = useRef<boolean>(false);
  const nativeCleanupRef = useRef<(() => void) | null>(null);
  const isHost = isHostClient();
  const latestPartyStateRef = useRef(partyState);
  latestPartyStateRef.current = partyState;
  const latestInitialProgressRef = useRef(initialProgress);
  latestInitialProgressRef.current = initialProgress;

  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number>(() => {
    return item.metadata?.audio_tracks?.[0]?.index ?? 0;
  });
  const selectedAudioRef = useRef<number>(selectedAudioIndex);
  selectedAudioRef.current = selectedAudioIndex;
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);
  const [streamStatus, setStreamStatus] = useState<string>('CONNECTING');
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isSwitchingAudio, setIsSwitchingAudio] = useState(false);

  // Embedded overlay & drawer states
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const [activePopover, setActivePopover] = useState<'none' | 'tracks' | 'subSettings'>('none');
  const [partySyncEnabled, setPartySyncEnabled] = useState<boolean>(true);
  const [activePeers, setActivePeers] = useState<number>(1);
  const [isSyncingParty, setIsSyncingParty] = useState<boolean>(false);
  const lastAppliedSeqRef = useRef<number>(partyState?.event_seq ?? 0);
  const isWatchPartyActive = Boolean(serverStatus?.tunnel?.active || partyState?.enabled);
  const watchPartyQualityRef = useRef<number | undefined>(
    isWatchPartyActive || !isHost ? 1080 : undefined
  );
  watchPartyQualityRef.current = isWatchPartyActive || !isHost ? 1080 : undefined;
  const displayPeers = Math.max(activePeers, partyState?.active_peers ?? 1);
  const serverPartyEnabledRef = useRef<boolean>(isWatchPartyActive);

  useEffect(() => {
    serverPartyEnabledRef.current = isWatchPartyActive;
  }, [isWatchPartyActive]);

  // Custom HUD transport state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(() => item.metadata?.duration_seconds ?? 0);
  const [bufferedEnd, setBufferedEnd] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const playbackRateRef = useRef<number>(playbackRate);
  playbackRateRef.current = playbackRate;
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [autoplayMutedNotice, setAutoplayMutedNotice] = useState<boolean>(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState<boolean>(false);

  const safePlay = useCallback((video: HTMLVideoElement, fromUserAction: boolean = false) => {
    if (fromUserAction) {
      autoplayBlockedRef.current = false;
      setAutoplayBlocked(false);
    } else if (autoplayBlockedRef.current) {
      return;
    }
    const gen = streamGenRef.current;
    video.play().catch((err) => {
      if (streamGenRef.current !== gen) return;
      const errName = (err as { name?: string })?.name;
      if (errName === 'AbortError') return;
      if (errName === 'NotAllowedError') {
        if (!fromUserAction && !video.muted) {
          // Mobile browsers block unmuted autoplay after async HLS load; start muted so video renders live
          video.muted = true;
          autoplayMutedRef.current = true;
          setIsMuted(true);
          setAutoplayMutedNotice(true);
          video.play().catch((mutedErr) => {
            if (streamGenRef.current !== gen) return;
            const mutedErrName = (mutedErr as { name?: string })?.name;
            if (mutedErrName === 'AbortError') return;
            video.muted = false;
            autoplayMutedRef.current = false;
            setIsMuted(false);
            setAutoplayMutedNotice(false);
            autoplayBlockedRef.current = true;
            setAutoplayBlocked(true);
            setStreamStatus('TAP PLAY ▶');
            setControlsVisible(true);
          });
          return;
        }
        autoplayBlockedRef.current = true;
        setAutoplayBlocked(true);
        setStreamStatus('TAP PLAY ▶');
        setControlsVisible(true);
        return;
      }
      console.warn('Video playback failed:', err);
    });
  }, []);
  const [hoverTime, setHoverTime] = useState<{ time: number; percent: number } | null>(null);

  // Custom rendered subtitle text & user-customizable settings
  const [activeCueText, setActiveCueText] = useState<string>('');
  const [subSettings, setSubSettings] = useState<SubtitleSettings>(loadSubtitleSettings);

  const updateSubSettings = (patch: Partial<SubtitleSettings>) => {
    setSubSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SUB_SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const audioTracks: AudioTrack[] = item.metadata?.audio_tracks ?? [];
  const subtitleTracks: SubtitleTrack[] = item.metadata?.subtitle_tracks ?? [];

  // Auto-hide embedded controls after 2.5s of mouse inactivity during playback
  const resetControlsHideTimer = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (isPlaying && activePopover === 'none') {
      hideTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, 2500);
    }
  }, [isPlaying, activePopover]);

  useEffect(() => {
    resetControlsHideTimer();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [isPlaying, activePopover, resetControlsHideTimer]);

  // Initialize or reload HLS stream starting from resumeTime (seconds in source file)
  const initStream = useCallback(
    (audioIdx: number, resumeTime: number = 0) => {
      const video = videoRef.current;
      if (!video) return;

      if (pendingSeekTimerRef.current !== null) {
        window.clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }

      if (nativeCleanupRef.current) {
        nativeCleanupRef.current();
        nativeCleanupRef.current = null;
      }

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      // Quantize FFmpeg start offsets to 4s buckets so desktop host & mobile peers share one transcoder
      const startOffset = resumeTime >= 4 ? Math.floor(resumeTime / 4) * 4 : 0;
      const gen = ++streamGenRef.current;
      streamOffsetRef.current = startOffset;
      isStreamReadyRef.current = false;
      streamReadyAtRef.current = 0;
      lastSeekRestartAtRef.current = Date.now();
      lastHudUpdateAtRef.current = 0;
      lastProgressSaveAtRef.current = 0;
      video.playbackRate = playbackRateRef.current;
      setCurrentTime(resumeTime > 0 ? resumeTime : startOffset);
      setBufferedEnd(0);
      setStreamStatus('CONNECTING');
      setPlayerError(null);

      const streamUrl = api.getMasterStreamUrl(
        item.id,
        audioIdx,
        startOffset,
        watchPartyQualityRef.current
      );

      if (Hls.isSupported()) {
        let fatalNetworkRetries = 0;
        let fatalMediaRetries = 0;
        let lastStallKickAt = 0;

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          startFragPrefetch: true,
          capLevelToPlayerSize: true,
          maxBufferLength: 24,
          maxMaxBufferLength: 48,
          backBufferLength: 20,
          manifestLoadingTimeOut: 30000,
          manifestLoadingMaxRetry: 10,
          manifestLoadingRetryDelay: 1000,
          levelLoadingTimeOut: 30000,
          levelLoadingMaxRetry: 10,
          levelLoadingRetryDelay: 1000,
          fragLoadingTimeOut: 30000,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 1000,
          xhrSetup: (xhr) => {
            const invite = getOrCaptureInviteToken();
            if (invite) {
              xhr.setRequestHeader('x-monolith-invite', invite);
            }
          },
        });
        hlsRef.current = hls;

        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (streamGenRef.current !== gen) return;
          setStreamStatus('BUFFERING...');
          if (startOffset === 0 && resumeTime > 0 && resumeTime < 4) {
            video.currentTime = resumeTime;
          }
          const shouldPlay = desirePlayingRef.current !== false;
          desirePlayingRef.current = null;
          if (shouldPlay) {
            safePlay(video);
          } else {
            video.pause();
          }
        });

        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          if (streamGenRef.current !== gen) return;
          if (!isStreamReadyRef.current) {
            isStreamReadyRef.current = true;
            streamReadyAtRef.current = Date.now();
          }
          if (video.paused && video.currentTime === 0 && video.buffered.length > 0 && video.buffered.end(0) > 0.1) {
            video.currentTime = Math.min(0.05, video.buffered.start(0) + 0.02);
          }
          setStreamStatus((prev) =>
            prev === 'TAP PLAY ▶' ? prev : autoplayMutedRef.current ? 'MUTED (TAP SOUND)' : 'STREAMING'
          );
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (streamGenRef.current !== gen) return;
          if (!data.fatal) {
            if (
              data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR &&
              !video.paused &&
              Date.now() - lastStallKickAt > 2500
            ) {
              lastStallKickAt = Date.now();
              hls.startLoad();
            }
            return;
          }
          if (data.fatal) {
            console.error('Fatal HLS error encountered:', data);
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                fatalNetworkRetries += 1;
                if (fatalNetworkRetries <= 4) {
                  setStreamStatus(`RETRYING STREAM (${fatalNetworkRetries}/4)...`);
                  if (
                    data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                    data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
                  ) {
                    hls.loadSource(streamUrl);
                  } else {
                    hls.startLoad();
                  }
                } else {
                  setStreamStatus('ERROR');
                  setPlayerError(`NETWORK ERROR: ${data.details.toUpperCase()}`);
                  hls.destroy();
                }
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                fatalMediaRetries += 1;
                if (fatalMediaRetries <= 3) {
                  setStreamStatus('RECOVERING MEDIA BUFFER...');
                  hls.recoverMediaError();
                } else {
                  setStreamStatus('ERROR');
                  setPlayerError(`MEDIA DECODER ERROR: ${data.details.toUpperCase()}`);
                  hls.destroy();
                }
                break;
              default:
                setStreamStatus('ERROR');
                setPlayerError(`TRANSCODER ERROR: ${data.details.toUpperCase()}`);
                hls.destroy();
                break;
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        const ac = new AbortController();
        nativeCleanupRef.current = () => ac.abort();

        const startOrPauseNative = () => {
          const shouldPlay = desirePlayingRef.current !== false;
          desirePlayingRef.current = null;
          if (shouldPlay) {
            safePlay(video);
          } else {
            video.pause();
          }
        };

        video.pause();
        video.src = streamUrl;
        video.load();

        video.addEventListener(
          'loadedmetadata',
          () => {
            if (streamGenRef.current !== gen) return;
            setStreamStatus('BUFFERING...');
            if (startOffset === 0 && resumeTime > 0 && resumeTime < 4) {
              video.currentTime = resumeTime;
            }
            startOrPauseNative();
          },
          { signal: ac.signal }
        );

        const markNativeReady = () => {
          if (streamGenRef.current !== gen) return;
          if (!isStreamReadyRef.current) {
            isStreamReadyRef.current = true;
            streamReadyAtRef.current = Date.now();
          }
          if (video.paused && video.currentTime === 0 && video.buffered.length > 0 && video.buffered.end(0) > 0.1) {
            video.currentTime = Math.min(0.05, video.buffered.start(0) + 0.02);
          }
          setStreamStatus((prev) =>
            prev === 'TAP PLAY ▶' ? prev : autoplayMutedRef.current ? 'MUTED (TAP SOUND)' : 'STREAMING'
          );
          if (desirePlayingRef.current !== null) {
            startOrPauseNative();
          }
        };

        video.addEventListener('loadeddata', markNativeReady, { signal: ac.signal });
        video.addEventListener('canplay', markNativeReady, { signal: ac.signal });
        video.addEventListener(
          'error',
          () => {
            if (streamGenRef.current !== gen) return;
            const mediaErr = video.error;
            if (mediaErr) {
              setStreamStatus('ERROR');
              setPlayerError(`SAFARI HLS ERROR (CODE ${mediaErr.code}): ${mediaErr.message || 'STREAM UNAVAILABLE'}`);
            }
          },
          { signal: ac.signal }
        );
      } else {
        setPlayerError('FATAL: BROWSER ENVIRONMENT DOES NOT SUPPORT HLS PLAYBACK');
      }
    },
    [item.id, safePlay]
  );

  // Initialize playback on mount or when media item changes
  useEffect(() => {
    const initialAudio = item.metadata?.audio_tracks?.[0]?.index ?? 0;
    setSelectedAudioIndex(initialAudio);
    setDuration(item.metadata?.duration_seconds ?? 0);

    const p = latestPartyStateRef.current;
    const prog = latestInitialProgressRef.current;
    const startAt =
      p?.enabled && p.media_id === item.id && p.current_time >= 3
        ? p.current_time
        : prog && prog.currentTime > 5 && prog.percent < 96
        ? prog.currentTime
        : 0;

    if (p?.enabled && p.media_id === item.id) {
      desirePlayingRef.current = p.is_playing;
      lastAppliedSeqRef.current = Math.max(lastAppliedSeqRef.current, p.event_seq ?? 0);
    } else {
      desirePlayingRef.current = null;
    }
    autoplayBlockedRef.current = false;
    autoplayMutedRef.current = false;
    setAutoplayBlocked(false);
    setAutoplayMutedNotice(false);
    setCurrentTime(startAt);
    initStream(initialAudio, startAt);

    return () => {
      streamGenRef.current += 1;
      if (pendingSeekTimerRef.current !== null) {
        window.clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
      if (nativeCleanupRef.current) {
        nativeCleanupRef.current();
        nativeCleanupRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [initStream, item.id]);

  const syncCustomSubtitles = useCallback((video: HTMLVideoElement, movieTime: number) => {
    const activeTrack = Array.from(video.textTracks).find((t) => t.mode === 'hidden');
    if (!activeTrack?.cues) {
      setActiveCueText((prev) => (prev === '' ? prev : ''));
      return;
    }
    const lines: string[] = [];
    for (let i = 0; i < activeTrack.cues.length; i++) {
      const cue = activeTrack.cues[i] as VTTCue;
      if (movieTime >= cue.startTime && movieTime <= cue.endTime && cue.text) {
        lines.push(cue.text.replace(/<[^>]+>/g, ''));
      }
    }
    const nextText = lines.join('\n');
    setActiveCueText((prev) => (prev === nextText ? prev : nextText));
  }, []);

  // Attach HTML5 video event listeners for custom HUD state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => {
      autoNextTriggeredRef.current = false;
      autoplayBlockedRef.current = false;
      setAutoplayBlocked(false);
      setIsPlaying(true);
      setStreamStatus(autoplayMutedRef.current ? 'MUTED (TAP SOUND)' : 'STREAMING');
    };
    const onCanPlay = () => {
      if (!isStreamReadyRef.current) {
        isStreamReadyRef.current = true;
        streamReadyAtRef.current = Date.now();
      }
    };
    const onPause = () => {
      setIsPlaying(false);
      setControlsVisible(true);
      if (isStreamReadyRef.current) {
        setCurrentTime(streamOffsetRef.current + video.currentTime);
      }
    };
    const onEnded = () => {
      if (autoNext && nextItem && onSelectItem && !autoNextTriggeredRef.current) {
        autoNextTriggeredRef.current = true;
        onSelectItem(nextItem);
      }
    };
    const onTimeUpdate = () => {
      if (!isStreamReadyRef.current) return;
      const now = Date.now();
      const cur = streamOffsetRef.current + video.currentTime;
      if (streamOffsetRef.current > 0) {
        syncCustomSubtitles(video, cur);
      }
      if (now - lastHudUpdateAtRef.current >= 900 || video.paused) {
        lastHudUpdateAtRef.current = now;
        setCurrentTime(cur);
        if (video.buffered.length > 0) {
          setBufferedEnd(streamOffsetRef.current + video.buffered.end(video.buffered.length - 1));
        }
      }
      const metaDur = item.metadata?.duration_seconds ?? 0;
      const vidDur =
        Number.isFinite(video.duration) && video.duration > 0
          ? streamOffsetRef.current + video.duration
          : 0;
      const effDur = Math.max(metaDur, vidDur);
      if (effDur > 0 && cur > 1 && now - lastProgressSaveAtRef.current >= 2000) {
        lastProgressSaveAtRef.current = now;
        onProgressUpdate?.(item.id, cur, effDur);
      }
      if (
        autoNext &&
        nextItem &&
        onSelectItem &&
        effDur > 10 &&
        cur >= effDur - 0.7 &&
        !autoNextTriggeredRef.current
      ) {
        autoNextTriggeredRef.current = true;
        onSelectItem(nextItem);
      }
    };
    const onDurationChange = () => {
      const metaDur = item.metadata?.duration_seconds ?? 0;
      const vidDur =
        Number.isFinite(video.duration) && video.duration > 0
          ? streamOffsetRef.current + video.duration
          : 0;
      setDuration(Math.max(metaDur, vidDur));
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
      if (!video.muted && autoplayMutedRef.current) {
        autoplayMutedRef.current = false;
        setAutoplayMutedNotice(false);
        if (!video.paused) {
          setStreamStatus('STREAMING');
        }
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('volumechange', onVolumeChange);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('volumechange', onVolumeChange);
    };
  }, [
    item.id,
    item.metadata?.duration_seconds,
    onProgressUpdate,
    autoNext,
    nextItem,
    onSelectItem,
    syncCustomSubtitles,
  ]);

  // Sync fullscreen state
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const broadcastPartyUpdate = useCallback(
    (playing: boolean, timeSec: number, isHeartbeat: boolean = false) => {
      if (!partySyncEnabled || !serverPartyEnabledRef.current) return;
      api
        .updatePartyState({
          media_id: item.id,
          media_title: item.file_name,
          is_playing: playing,
          current_time: timeSec,
          is_heartbeat: isHeartbeat,
        })
        .then((st) => {
          lastAppliedSeqRef.current = Math.max(lastAppliedSeqRef.current, st.event_seq);
          setActivePeers(st.active_peers);
        })
        .catch(() => {});
    },
    [partySyncEnabled, item.id, item.file_name]
  );

  const applyMovieSeek = useCallback(
    (
      movieTarget: number,
      immediate: boolean = false,
      shouldBroadcast: boolean = false,
      playingOverride?: boolean
    ) => {
      const video = videoRef.current;
      if (!video) return;
      const targetPlaying = playingOverride ?? !video.paused;
      const localTarget = movieTarget - streamOffsetRef.current;
      if (isLocalTimeSeekable(video, localTarget)) {
        video.currentTime = localTarget;
        setCurrentTime(movieTarget);
        if (shouldBroadcast) {
          broadcastPartyUpdate(targetPlaying, movieTarget, false);
        }
        return;
      }
      desirePlayingRef.current = targetPlaying;
      setCurrentTime(movieTarget);
      if (pendingSeekTimerRef.current !== null) {
        window.clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
      const commit = () => {
        if (shouldBroadcast) {
          broadcastPartyUpdate(targetPlaying, movieTarget, false);
        }
        initStream(selectedAudioRef.current, movieTarget);
      };
      if (immediate) {
        commit();
      } else {
        pendingSeekTimerRef.current = window.setTimeout(() => {
          pendingSeekTimerRef.current = null;
          commit();
        }, 220);
      }
    },
    [initStream, broadcastPartyUpdate]
  );

  // Watch Party anchor (.exe host leads clock & media; guests follow and can send control events)
  useEffect(() => {
    if (!partySyncEnabled || !isWatchPartyActive) return;
    const myPeerId = getPeerId();
    let tickCount = 0;

    const syncInterval = window.setInterval(async () => {
      tickCount += 1;
      try {
        const party = await api.getPartyState();
        serverPartyEnabledRef.current = party.enabled;
        setActivePeers(party.active_peers);
        if (!party.enabled) return;

        // If Watch Party was just toggled on while this video is open, register this media item
        if (!party.media_id && videoRef.current) {
          broadcastPartyUpdate(
            !videoRef.current.paused,
            streamOffsetRef.current + videoRef.current.currentTime,
            false
          );
          return;
        }

        if (party.media_id !== item.id) return;
        const video = videoRef.current;
        if (!video) return;

        const moviePos = streamOffsetRef.current + video.currentTime;
        const isNewRemoteEvent =
          party.event_seq > lastAppliedSeqRef.current && party.updated_by !== myPeerId;

        if (isNewRemoteEvent) {
          lastAppliedSeqRef.current = party.event_seq;
          lastRemoteApplyAtRef.current = Date.now();
          desirePlayingRef.current = party.is_playing;

          if (autoplayBlockedRef.current && video.paused) {
            setCurrentTime(party.current_time);
            return;
          }

          const localTarget = party.current_time - streamOffsetRef.current;
          const canSeekLocally = isLocalTimeSeekable(video, localTarget);
          const signedDrift = party.current_time - moviePos;
          const needsSeek =
            (canSeekLocally && Math.abs(signedDrift) > 1.5) ||
            signedDrift < -2.5 ||
            signedDrift > 8.0;

          if (needsSeek) {
            applyMovieSeek(party.current_time, true, false, party.is_playing);
          } else if (isStreamReadyRef.current) {
            if (party.is_playing && video.paused) {
              safePlay(video);
            } else if (!party.is_playing && !video.paused) {
              video.pause();
            }
          }
          return;
        }

        if (isHost) {
          // .exe Host is the main anchor: broadcast authoritative time via heartbeat (without bumping event_seq)
          if (
            tickCount % 2 === 0 &&
            isStreamReadyRef.current &&
            pendingSeekTimerRef.current === null &&
            Date.now() - lastRemoteApplyAtRef.current > 1500 &&
            Date.now() - lastSeekRestartAtRef.current > 2000
          ) {
            broadcastPartyUpdate(!video.paused, moviePos, true);
          }
          return;
        }

        if (autoplayBlockedRef.current) {
          if (!video.paused) {
            autoplayBlockedRef.current = false;
            setAutoplayBlocked(false);
          } else {
            // Do not destroy and re-init the stream every 12s while waiting for user tap on mobile
            setCurrentTime(party.current_time);
            return;
          }
        }

        // Wait until first segment is buffered and settled before evaluating guest drift
        const settledSince = Math.max(lastSeekRestartAtRef.current, streamReadyAtRef.current);
        if (!isStreamReadyRef.current || streamReadyAtRef.current === 0 || Date.now() - settledSince <= 4000) {
          return;
        }

        if (party.is_playing && video.paused) {
          safePlay(video);
        } else if (!party.is_playing && !video.paused) {
          video.pause();
        }

        const signedDrift = party.current_time - moviePos;
        const absDrift = Math.abs(signedDrift);
        const localTarget = party.current_time - streamOffsetRef.current;

        if (!party.is_playing) {
          if (
            absDrift > 2.5 &&
            (isLocalTimeSeekable(video, localTarget) || Date.now() - lastSeekRestartAtRef.current > 8000)
          ) {
            video.playbackRate = playbackRateRef.current;
            applyMovieSeek(party.current_time, true, false, false);
          }
          return;
        }

        if (absDrift <= 1.2) {
          if (Math.abs(video.playbackRate - playbackRateRef.current) > 0.01) {
            video.playbackRate = playbackRateRef.current;
          }
          return;
        }

        // Smooth rate nudging (0.95x-1.05x for small drift, 0.92x-1.08x up to 12s) avoids jarring seeks
        if (absDrift <= 12.0) {
          if (isLocalTimeSeekable(video, localTarget) && absDrift > 5.0) {
            video.currentTime = localTarget;
            video.playbackRate = playbackRateRef.current;
          } else {
            const nudge =
              absDrift <= 4.0
                ? signedDrift > 0
                  ? 1.05
                  : 0.95
                : signedDrift > 0
                ? 1.08
                : 0.92;
            const targetRate = Math.min(2.0, Math.max(0.5, playbackRateRef.current * nudge));
            if (Math.abs(video.playbackRate - targetRate) > 0.01) {
              video.playbackRate = targetRate;
            }
          }
          return;
        }

        if (isLocalTimeSeekable(video, localTarget) || Date.now() - lastSeekRestartAtRef.current > 8000) {
          video.playbackRate = playbackRateRef.current;
          applyMovieSeek(party.current_time, true, false, party.is_playing);
        }
      } catch {
        // ignore network hiccups
      }
    }, 1000);

    return () => window.clearInterval(syncInterval);
  }, [partySyncEnabled, isWatchPartyActive, isHost, item.id, broadcastPartyUpdate, applyMovieSeek, safePlay]);

  const handleRefreshParty = useCallback(async () => {
    setIsSyncingParty(true);
    try {
      const party = await api.getPartyState();
      setActivePeers(party.active_peers);
      const video = videoRef.current;
      if (video && party.media_id === item.id) {
        lastAppliedSeqRef.current = party.event_seq;
        lastRemoteApplyAtRef.current = Date.now();
        desirePlayingRef.current = party.is_playing;
        const moviePos = streamOffsetRef.current + video.currentTime;
        if (Math.abs(moviePos - party.current_time) > 1.0) {
          applyMovieSeek(party.current_time, true, false, party.is_playing);
        } else {
          if (party.is_playing && video.paused) {
            safePlay(video, true);
          } else if (!party.is_playing && !video.paused) {
            video.pause();
          }
        }
      }
    } catch (err) {
      console.warn('Manual party state refresh error:', err);
    } finally {
      setTimeout(() => setIsSyncingParty(false), 600);
    }
  }, [item.id, applyMovieSeek, safePlay]);

  const handleUnmuteAutoplay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    if (video.volume === 0) video.volume = 1;
    autoplayMutedRef.current = false;
    setIsMuted(false);
    setAutoplayMutedNotice(false);
    if (video.paused && desirePlayingRef.current !== false) {
      safePlay(video, true);
    } else if (!video.paused) {
      setStreamStatus('STREAMING');
    }
  }, [safePlay]);

  // Transport actions
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const wasBlocked = autoplayBlockedRef.current;
    const moviePos = streamOffsetRef.current + video.currentTime;
    if (video.paused) {
      if (autoplayMutedRef.current) {
        video.muted = false;
        autoplayMutedRef.current = false;
        setIsMuted(false);
        setAutoplayMutedNotice(false);
      }
      desirePlayingRef.current = true;
      const p = latestPartyStateRef.current;
      if (wasBlocked && !isHost && partySyncEnabled && p?.enabled && p.media_id === item.id) {
        if (Math.abs(p.current_time - moviePos) > 6.0) {
          autoplayBlockedRef.current = false;
          setAutoplayBlocked(false);
          applyMovieSeek(p.current_time, true, false, true);
          return;
        }
      }
      safePlay(video, true);
      if (!wasBlocked) {
        broadcastPartyUpdate(true, moviePos, false);
      }
    } else {
      desirePlayingRef.current = false;
      video.pause();
      broadcastPartyUpdate(false, moviePos, false);
    }
  }, [broadcastPartyUpdate, safePlay, isHost, partySyncEnabled, item.id, applyMovieSeek]);

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const vidDur =
        Number.isFinite(video.duration) && video.duration > 0
          ? streamOffsetRef.current + video.duration
          : 0;
      const maxDur = duration > 0 ? duration : vidDur;
      const curMovie = streamOffsetRef.current + video.currentTime;
      const next = Math.max(0, Math.min(maxDur || Infinity, curMovie + deltaSeconds));
      const wantPlay = desirePlayingRef.current ?? !video.paused;
      applyMovieSeek(next, true, true, wantPlay);
      resetControlsHideTimer();
    },
    [duration, resetControlsHideTimer, applyMovieSeek]
  );

  const seekTo = useCallback(
    (targetSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const clamped = Math.max(0, targetSeconds);
      const wantPlay = desirePlayingRef.current ?? !video.paused;
      applyMovieSeek(clamped, false, true, wantPlay);
    },
    [applyMovieSeek]
  );

  // Fetch chapters for the current media item
  useEffect(() => {
    let cancelled = false;
    api
      .getChapters(item.id)
      .then((chs) => {
        if (!cancelled) setChapters(chs);
      })
      .catch((err) => console.warn('Failed to load chapters:', err));
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  // Find active chapter marker (if any)
  const activeChapter = useMemo(() => {
    return chapters.find(
      (c) => currentTime >= c.start && currentTime < c.end
    );
  }, [chapters, currentTime]);

  // Determine Netflix-style skip action (Intro, Outro, or Next Episode)
  const activeSkip = useMemo(() => {
    if (activeChapter?.kind === 'intro') {
      return {
        label: 'SKIP INTRO ⏭',
        targetTime: activeChapter.end + 0.1,
        isNext: false,
      };
    }
    if (activeChapter?.kind === 'outro') {
      return {
        label: nextItem ? 'NEXT EPISODE ▶' : 'SKIP OUTRO ⏭',
        targetTime: activeChapter.end + 0.1,
        isNext: Boolean(nextItem),
      };
    }
    // Also if in the last 45 seconds of an episode and nextItem exists
    if (nextItem && duration > 90 && currentTime >= duration - 45) {
      return {
        label: 'NEXT EPISODE ▶',
        targetTime: duration,
        isNext: true,
      };
    }
    return null;
  }, [activeChapter, currentTime, duration, nextItem]);

  const handleSkipAction = useCallback(() => {
    if (!activeSkip) return;
    if (activeSkip.isNext && nextItem && onSelectItem) {
      onSelectItem(nextItem);
    } else {
      seekTo(activeSkip.targetTime);
    }
  }, [activeSkip, nextItem, onSelectItem, seekTo]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
    if (!video.muted && autoplayMutedRef.current) {
      autoplayMutedRef.current = false;
      setAutoplayMutedNotice(false);
      if (!video.paused) setStreamStatus('STREAMING');
    }
  }, []);

  const handleVolumeChange = useCallback((newVol: number) => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = Math.max(0, Math.min(1, newVol));
    video.volume = clamped;
    video.muted = clamped === 0;
    setVolume(clamped);
    setIsMuted(clamped === 0);
  }, []);

  const cyclePlaybackSpeed = useCallback(() => {
    const speeds = [0.5, 1, 1.25, 1.5, 2];
    const nextIdx = (speeds.indexOf(playbackRate) + 1) % speeds.length;
    const nextSpeed = speeds[nextIdx];
    const video = videoRef.current;
    if (video) {
      video.playbackRate = nextSpeed;
    }
    setPlaybackRate(nextSpeed);
  }, [playbackRate]);

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (!document.fullscreenElement) {
      stage.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  }, []);

  const cycleSubtitles = useCallback(() => {
    const textSubs = subtitleTracks.filter((s) => !s.is_bitmap);
    if (textSubs.length === 0) return;
    if (selectedSubtitleIndex === null) {
      setSelectedSubtitleIndex(textSubs[0].index);
    } else {
      const curPos = textSubs.findIndex((s) => s.index === selectedSubtitleIndex);
      if (curPos === -1 || curPos + 1 >= textSubs.length) {
        setSelectedSubtitleIndex(null);
      } else {
        setSelectedSubtitleIndex(textSubs[curPos + 1].index);
      }
    }
  }, [subtitleTracks, selectedSubtitleIndex]);

  // Global keyboard shortcuts (Space, K, J, L, Arrows, F, M, C, Escape)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'j':
          e.preventDefault();
          seekBy(-10);
          break;
        case 'l':
          e.preventDefault();
          seekBy(10);
          break;
        case 'arrowleft':
          e.preventDefault();
          seekBy(-5);
          break;
        case 'arrowright':
          e.preventDefault();
          seekBy(5);
          break;
        case 'arrowup':
          e.preventDefault();
          handleVolumeChange(volume + 0.1);
          break;
        case 'arrowdown':
          e.preventDefault();
          handleVolumeChange(volume - 0.1);
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'c':
          e.preventDefault();
          cycleSubtitles();
          break;
        case 'escape':
          if (activePopover !== 'none') {
            setActivePopover('none');
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    togglePlay,
    seekBy,
    handleVolumeChange,
    volume,
    toggleMute,
    toggleFullscreen,
    cycleSubtitles,
    activePopover,
  ]);

  // Handle Subtitle track switching with custom overlay cue rendering (hidden native track + cuechange listener)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const existingTracks = video.querySelectorAll('track');
    existingTracks.forEach((t) => t.remove());
    setActiveCueText('');

    if (selectedSubtitleIndex !== null) {
      const sub = subtitleTracks.find((s) => s.index === selectedSubtitleIndex);
      if (sub) {
        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = sub.title || sub.language?.toUpperCase() || `TRACK ${sub.index}`;
        trackEl.srclang = sub.language || 'en';
        trackEl.src = api.getSubtitleUrl(item.id, sub.index);
        trackEl.default = true;

        const syncCues = () => {
          const tt = trackEl.track;
          tt.mode = 'hidden'; // Render via our customizable subtitle overlay instead of browser default
          if (streamOffsetRef.current > 0) {
            syncCustomSubtitles(video, streamOffsetRef.current + video.currentTime);
            return;
          }
          const cues = tt.activeCues;
          if (cues && cues.length > 0) {
            const lines: string[] = [];
            for (let i = 0; i < cues.length; i++) {
              const cue = cues[i] as VTTCue;
              if (cue.text) {
                lines.push(cue.text.replace(/<[^>]+>/g, ''));
              }
            }
            setActiveCueText(lines.join('\n'));
          } else {
            setActiveCueText('');
          }
        };

        trackEl.addEventListener('load', () => {
          trackEl.track.mode = 'hidden';
          trackEl.track.addEventListener('cuechange', syncCues);
          syncCues();
        });

        video.appendChild(trackEl);
      }
    } else {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = 'disabled';
      }
    }
  }, [item.id, selectedSubtitleIndex, subtitleTracks]);

  // Handle Audio track selection
  const handleSelectAudio = async (index: number) => {
    if (index === selectedAudioIndex || isSwitchingAudio) return;

    setIsSwitchingAudio(true);
    setStreamStatus(`SWITCHING AUDIO TO TRACK ${index}...`);

    try {
      await api.switchAudioTrack(item.id, index);
    } catch (err) {
      console.warn('Backend audio switch notification failed (will reload stream URL):', err);
    }

    const video = videoRef.current;
    const resumePos = streamOffsetRef.current + (video ? video.currentTime : 0);

    setSelectedAudioIndex(index);
    initStream(index, resumePos);
    setIsSwitchingAudio(false);
  };

  const effectiveDuration = Math.max(duration, currentTime, 1);
  const progressPercent = Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100));
  const bufferPercent = Math.min(100, Math.max(0, (bufferedEnd / effectiveDuration) * 100));
  const effectiveVolume = isMuted ? 0 : volume;

  const handleTimelineMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = seekBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime({
      time: ratio * effectiveDuration,
      percent: ratio * 100,
    });
  };

  const showOverlay = controlsVisible || !isPlaying || activePopover !== 'none';

  return (
    <div className={`player-container ${showPlaylist && playlistOpen ? 'with-playlist' : ''}`}>
      <div className="player-main-pane">
        {/* Unified Embedded Video Stage (Everything overlaid on the video canvas, auto-hiding on inactivity) */}
        <div
          ref={stageRef}
          className={`player-stage embedded-stage ${isFullscreen ? 'is-fullscreen' : ''} ${
            showOverlay ? 'controls-visible' : 'controls-hidden'
          }`}
          onMouseMove={resetControlsHideTimer}
          onMouseEnter={resetControlsHideTimer}
          onTouchStart={resetControlsHideTimer}
        >
          <div
            className="player-video-wrapper"
            onClick={() => {
              if (activePopover !== 'none') {
                setActivePopover('none');
              } else if (autoplayMutedRef.current && videoRef.current && !videoRef.current.paused) {
                handleUnmuteAutoplay();
              } else {
                togglePlay();
              }
            }}
            onDoubleClick={toggleFullscreen}
          >
            <video
              ref={videoRef}
              className="player-video-element"
              playsInline
              preload="auto"
            />

            {autoplayMutedNotice && (
              <button
                type="button"
                className="brutalist-btn sm active"
                style={{
                  position: 'absolute',
                  top: '56px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 25,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleUnmuteAutoplay();
                }}
              >
                [🔇 SOUND MUTED — TAP TO UNMUTE]
              </button>
            )}

            {autoplayBlocked && !isPlaying && (
              <button
                type="button"
                className="on-video-action-btn primary"
                style={{
                  position: 'absolute',
                  top: '56px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 25,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlay();
                }}
              >
                ▶ TAP PLAY TO JOIN STREAM
              </button>
            )}

            {/* Netflix-style Skip Intro / Skip Credits / Next Episode floating button */}
            {activeSkip && (
              <button
                type="button"
                className="skip-marker-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSkipAction();
                }}
                title={activeSkip.label}
              >
                {activeSkip.label}
              </button>
            )}

            {/* Customizable Subtitle Overlay */}
            {activeCueText && (
              <div
                className="custom-subtitle-overlay"
                style={{
                  bottom: `${subSettings.bottomOffset}%`,
                }}
              >
                <span
                  className="custom-subtitle-box"
                  style={{
                    fontSize: `${subSettings.fontSize}rem`,
                    color: subSettings.textColor,
                    backgroundColor: `rgba(0, 0, 0, ${subSettings.bgOpacity})`,
                    textShadow: subSettings.outline
                      ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 6px #000'
                      : 'none',
                  }}
                >
                  {activeCueText}
                </span>
              </div>
            )}

            {/* Embedded Top Overlay Bar (auto-hides with controls) */}
            <div
              className={`embedded-top-bar ${showOverlay ? 'visible' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="player-header-left">
                <button type="button" className="brutalist-btn sm" onClick={onBack}>
                  [&lt; BACK]
                </button>
                <div className="player-title" title={item.file_name}>
                  {item.file_name}
                </div>
              </div>
              <div className="player-header-badges">
                <span className="badge badge-inverted">
                  [{Math.round(progressPercent)}% WATCHED]
                </span>
                <span className="badge">[{streamStatus}]</span>
                {isWatchPartyActive && (
                  <>
                    <button
                      type="button"
                      className={`brutalist-btn sm ${partySyncEnabled ? 'active' : ''}`}
                      onClick={() => setPartySyncEnabled((v) => !v)}
                      title="Synchronize Play, Pause, and Seek with Watch Party viewers"
                    >
                      [PARTY SYNC: {partySyncEnabled ? `ON (${displayPeers})` : 'OFF'}]
                    </button>
                    {partySyncEnabled && (
                      <button
                        type="button"
                        className="brutalist-btn sm"
                        onClick={handleRefreshParty}
                        disabled={isSyncingParty}
                        title="Manually poll and align playback with Watch Party peers"
                      >
                        {isSyncingParty ? '[SYNCING...]' : '[REFRESH SYNC ⟳]'}
                      </button>
                    )}
                  </>
                )}
                {showPlaylist && (
                  <>
                    <button
                      type="button"
                      className={`brutalist-btn sm ${autoNext ? 'active' : ''}`}
                      onClick={() => {
                        const nextVal = !autoNext;
                        setAutoNext(nextVal);
                        localStorage.setItem(AUTO_NEXT_STORAGE_KEY, String(nextVal));
                      }}
                      title="Automatically play the next episode when current completes"
                    >
                      [AUTO-NEXT: {autoNext ? 'ON' : 'OFF'}]
                    </button>
                    <button
                      type="button"
                      className={`brutalist-btn sm ${playlistOpen ? 'active' : ''}`}
                      onClick={() => setPlaylistOpen((v) => !v)}
                      title="Toggle Playlist Sidebar"
                    >
                      [EPISODES ({currentIndex + 1}/{playlist.length})]
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`brutalist-btn sm ${activePopover === 'tracks' ? 'active' : ''}`}
                  onClick={() =>
                    setActivePopover((p) => (p === 'tracks' ? 'none' : 'tracks'))
                  }
                >
                  [AUDIO / SUBS]
                </button>
                <button
                  type="button"
                  className={`brutalist-btn sm ${activePopover === 'subSettings' ? 'active' : ''}`}
                  onClick={() =>
                    setActivePopover((p) => (p === 'subSettings' ? 'none' : 'subSettings'))
                  }
                >
                  [SUB SETTINGS]
                </button>
              </div>
            </div>
          </div>

          {/* On-Video Center Transport Controls (Rewind 10s, Play/Pause, Forward 10s) */}
          <div
            className={`on-video-center-controls ${showOverlay ? 'visible' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="on-video-action-btn"
              onClick={() => seekBy(-10)}
              title="Rewind 10s (J)"
            >
              « 10S
            </button>
            <button
              type="button"
              className="on-video-action-btn primary"
              onClick={togglePlay}
              title="Play / Pause (Space)"
            >
              {streamStatus === 'CONNECTING'
                ? 'WAIT...'
                : isPlaying
                ? '❚❚ PAUSE'
                : '▶ PLAY'}
            </button>
            <button
              type="button"
              className="on-video-action-btn"
              onClick={() => seekBy(10)}
              title="Forward 10s (L)"
            >
              10S »
            </button>
          </div>

          {/* Embedded Audio & Subtitle Track Routing Popover */}
          {activePopover === 'tracks' && (
            <div
              className="embedded-popover"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="embedded-popover-header">
                <span>[AUDIO & SUBTITLE ROUTING]</span>
                <button
                  type="button"
                  className="brutalist-btn sm"
                  onClick={() => setActivePopover('none')}
                >
                  [X CLOSE]
                </button>
              </div>

              <div className="embedded-popover-body">
                <div className="popover-section">
                  <div className="popover-section-title">
                    AUDIO TRACKS (ACTIVE: #{selectedAudioIndex})
                  </div>
                  <div className="track-list">
                    {audioTracks.length > 0 ? (
                      audioTracks.map((track) => (
                        <div
                          key={track.index}
                          className={`track-item ${
                            track.index === selectedAudioIndex ? 'selected' : ''
                          }`}
                          onClick={() => handleSelectAudio(track.index)}
                          role="button"
                          tabIndex={0}
                        >
                          <div>
                            <strong>#{track.index}:</strong>{' '}
                            {track.title || track.codec.toUpperCase()} [
                            {track.language ? track.language.toUpperCase() : 'UND'}]
                          </div>
                          <div>{track.channels}CH</div>
                        </div>
                      ))
                    ) : (
                      <div style={{ opacity: 0.7, padding: '6px' }}>[DEFAULT AUDIO STREAM]</div>
                    )}
                  </div>
                </div>

                <div className="popover-section">
                  <div className="popover-section-title">
                    SUBTITLE TRACKS (ACTIVE:{' '}
                    {selectedSubtitleIndex !== null ? `#${selectedSubtitleIndex}` : 'OFF'})
                  </div>
                  <div className="track-list">
                    <div
                      className={`track-item ${selectedSubtitleIndex === null ? 'selected' : ''}`}
                      onClick={() => setSelectedSubtitleIndex(null)}
                      role="button"
                      tabIndex={0}
                    >
                      <strong>[DISABLE SUBTITLES]</strong>
                      <span>OFF</span>
                    </div>
                    {subtitleTracks.map((sub) => (
                      <div
                        key={sub.index}
                        className={`track-item ${
                          selectedSubtitleIndex === sub.index ? 'selected' : ''
                        }`}
                        style={
                          sub.is_bitmap ? { opacity: 0.5, cursor: 'not-allowed' } : undefined
                        }
                        onClick={() => {
                          if (!sub.is_bitmap) setSelectedSubtitleIndex(sub.index);
                        }}
                        role="button"
                        tabIndex={sub.is_bitmap ? -1 : 0}
                      >
                        <div>
                          <strong>#{sub.index}:</strong> {sub.title || sub.codec.toUpperCase()} [
                          {sub.language ? sub.language.toUpperCase() : 'UND'}]
                        </div>
                        <div>
                          {sub.is_bitmap
                            ? '[BITMAP]'
                            : sub.is_forced
                            ? '[FORCED]'
                            : sub.is_default
                            ? '[DEFAULT]'
                            : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Embedded Subtitle Appearance Settings Popover */}
          {activePopover === 'subSettings' && (
            <div
              className="embedded-popover"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="embedded-popover-header">
                <span>[SUBTITLE APPEARANCE SETTINGS]</span>
                <button
                  type="button"
                  className="brutalist-btn sm"
                  onClick={() => setActivePopover('none')}
                >
                  [X CLOSE]
                </button>
              </div>

              <div className="embedded-popover-body">
                {/* Font Size */}
                <div className="sub-setting-row">
                  <span>FONT SIZE: {(subSettings.fontSize * 100).toFixed(0)}%</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {[
                      { label: 'SM', val: 1.0 },
                      { label: 'MD', val: 1.35 },
                      { label: 'LG', val: 1.75 },
                      { label: 'XL', val: 2.2 },
                    ].map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        className={`brutalist-btn sm ${
                          Math.abs(subSettings.fontSize - opt.val) < 0.05 ? 'active' : ''
                        }`}
                        onClick={() => updateSubSettings({ fontSize: opt.val })}
                      >
                        [{opt.label}]
                      </button>
                    ))}
                  </div>
                </div>

                {/* Text Color */}
                <div className="sub-setting-row">
                  <span>TEXT COLOR:</span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {[
                      { label: 'WHITE', val: '#FFFFFF' },
                      { label: 'YELLOW', val: '#FFFF00' },
                      { label: 'CYAN', val: '#00FFFF' },
                      { label: 'GREEN', val: '#00FF66' },
                    ].map((c) => (
                      <button
                        key={c.label}
                        type="button"
                        className={`brutalist-btn sm ${
                          subSettings.textColor === c.val ? 'active' : ''
                        }`}
                        onClick={() => updateSubSettings({ textColor: c.val })}
                      >
                        [{c.label}]
                      </button>
                    ))}
                  </div>
                </div>

                {/* Background Opacity */}
                <div className="sub-setting-row">
                  <span>BOX OPACITY: {Math.round(subSettings.bgOpacity * 100)}%</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {[
                      { label: '0%', val: 0 },
                      { label: '50%', val: 0.5 },
                      { label: '75%', val: 0.75 },
                      { label: '100%', val: 1.0 },
                    ].map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        className={`brutalist-btn sm ${
                          Math.abs(subSettings.bgOpacity - o.val) < 0.05 ? 'active' : ''
                        }`}
                        onClick={() => updateSubSettings({ bgOpacity: o.val })}
                      >
                        [{o.label}]
                      </button>
                    ))}
                  </div>
                </div>

                {/* Vertical Position / Offset */}
                <div className="sub-setting-row">
                  <span>VERTICAL OFFSET: {subSettings.bottomOffset}%</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {[
                      { label: 'LOW', val: 6 },
                      { label: 'NORMAL', val: 12 },
                      { label: 'HIGH', val: 20 },
                      { label: 'TOP-MID', val: 30 },
                    ].map((pos) => (
                      <button
                        key={pos.label}
                        type="button"
                        className={`brutalist-btn sm ${
                          subSettings.bottomOffset === pos.val ? 'active' : ''
                        }`}
                        onClick={() => updateSubSettings({ bottomOffset: pos.val })}
                      >
                        [{pos.label}]
                      </button>
                    ))}
                  </div>
                </div>

                {/* Hard Text Outline Toggle & Reset */}
                <div className="sub-setting-row">
                  <span>TEXT OUTLINE:</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      className={`brutalist-btn sm ${subSettings.outline ? 'active' : ''}`}
                      onClick={() => updateSubSettings({ outline: !subSettings.outline })}
                    >
                      [{subSettings.outline ? 'ON' : 'OFF'}]
                    </button>
                    <button
                      type="button"
                      className="brutalist-btn sm"
                      onClick={() => updateSubSettings(DEFAULT_SUB_SETTINGS)}
                    >
                      [RESET DEFAULTS]
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {playerError && (
            <div
              className="hud-error-box"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ fontSize: '1.1rem', marginBottom: '8px' }}>[STREAM ERROR]</h3>
              <p style={{ fontSize: '0.9rem' }}>{playerError}</p>
              <button
                type="button"
                className="brutalist-btn badge-inverted"
                style={{ marginTop: '12px' }}
                onClick={() => initStream(selectedAudioIndex, currentTime)}
              >
                [RETRY STREAM]
              </button>
            </div>
          )}

          {/* Embedded Bottom HUD Transport Bar (auto-hides on mouse inactivity) */}
          <div
            className={`hud-deck embedded-hud-deck ${showOverlay ? 'visible' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Interactive Scrub Timeline with Time Preview */}
            <div
              ref={seekBarRef}
              className="hud-timeline-wrapper"
              onMouseMove={handleTimelineMouseMove}
              onMouseLeave={() => setHoverTime(null)}
            >
              {hoverTime && (
                <div
                  className="hud-timeline-tooltip"
                  style={{ left: `${Math.min(94, Math.max(6, hoverTime.percent))}%` }}
                >
                  [{formatTime(hoverTime.time)}]
                </div>
              )}
              {effectiveDuration > 0 &&
                chapters.map((ch, idx) => {
                  const leftPct = (ch.start / effectiveDuration) * 100;
                  return (
                    <div
                      key={idx}
                      className={`timeline-chapter-marker ${ch.kind ? `marker-${ch.kind}` : ''}`}
                      style={{ left: `${leftPct}%` }}
                      title={`${ch.title || 'Chapter'} (${formatTime(ch.start)} - ${formatTime(ch.end)})`}
                    />
                  );
                })}
              <div className="hud-timeline-buffer" style={{ width: `${bufferPercent}%` }} />
              <input
                type="range"
                aria-label="Seek timeline"
                aria-valuetext={`${formatTime(currentTime)} of ${formatTime(effectiveDuration)}`}
                className="brutalist-slider hud-seek-slider"
                min={0}
                max={effectiveDuration}
                step={0.1}
                value={currentTime}
                style={
                  {
                    '--attr-min': 0,
                    '--attr-max': effectiveDuration,
                    '--control-value': currentTime,
                    '--slider-progress': `${progressPercent}%`,
                  } as React.CSSProperties
                }
                onChange={(e) => seekTo(parseFloat(e.target.value))}
              />
            </div>

            {/* Primary Transport Controls Row */}
            <div className="hud-controls-row">
              <div className="hud-controls-group">
                <button
                  type="button"
                  className="brutalist-btn sm hud-btn"
                  onClick={togglePlay}
                  title="Play / Pause (Space or K)"
                >
                  {isPlaying ? '[❚❚]' : '[▶]'}
                </button>

                <button
                  type="button"
                  className="brutalist-btn sm hud-btn"
                  onClick={() => seekBy(-10)}
                  title="Rewind 10s (J)"
                >
                  [-10S]
                </button>

                <button
                  type="button"
                  className="brutalist-btn sm hud-btn"
                  onClick={() => seekBy(10)}
                  title="Forward 10s (L)"
                >
                  [+10S]
                </button>

                <span className="hud-timecode">
                  {formatTime(currentTime)} / {formatTime(effectiveDuration)}
                </span>
              </div>

              <div className="hud-controls-group">
                {/* Volume Control */}
                <div className="hud-volume-box">
                  <button
                    type="button"
                    className="brutalist-btn sm hud-btn"
                    onClick={toggleMute}
                    title="Mute / Unmute (M)"
                  >
                    {isMuted || effectiveVolume === 0
                      ? '[MUTE]'
                      : `[VOL ${Math.round(effectiveVolume * 100)}%]`}
                  </button>
                  <input
                    type="range"
                    aria-label="Volume"
                    aria-valuetext={`${Math.round(effectiveVolume * 100)}%`}
                    className="brutalist-slider hud-volume-slider"
                    min={0}
                    max={1}
                    step={0.02}
                    value={effectiveVolume}
                    style={
                      {
                        '--attr-min': 0,
                        '--attr-max': 1,
                        '--control-value': effectiveVolume,
                        '--slider-progress': `${effectiveVolume * 100}%`,
                      } as React.CSSProperties
                    }
                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                  />
                </div>

                {/* Playback Speed */}
                <button
                  type="button"
                  className="brutalist-btn sm hud-btn"
                  onClick={cyclePlaybackSpeed}
                  title="Cycle Playback Speed"
                >
                  [{playbackRate}X]
                </button>

                {/* Subtitle Quick Cycle */}
                <button
                  type="button"
                  className={`brutalist-btn sm hud-btn ${
                    selectedSubtitleIndex !== null ? 'active' : ''
                  }`}
                  onClick={cycleSubtitles}
                  title="Cycle Subtitles (C)"
                >
                  [CC: {selectedSubtitleIndex !== null ? `#${selectedSubtitleIndex}` : 'OFF'}]
                </button>

                {/* Track & Subtitle Settings Triggers */}
                <button
                  type="button"
                  className={`brutalist-btn sm hud-btn ${
                    activePopover === 'tracks' ? 'active' : ''
                  }`}
                  onClick={() =>
                    setActivePopover((p) => (p === 'tracks' ? 'none' : 'tracks'))
                  }
                  title="Audio & Subtitle Tracks"
                >
                  [TRACKS]
                </button>

                <button
                  type="button"
                  className={`brutalist-btn sm hud-btn ${
                    activePopover === 'subSettings' ? 'active' : ''
                  }`}
                  onClick={() =>
                    setActivePopover((p) => (p === 'subSettings' ? 'none' : 'subSettings'))
                  }
                  title="Subtitle Style Settings"
                >
                  [SUB STYLE]
                </button>

                {/* Fullscreen Toggle */}
                <button
                  type="button"
                  className="brutalist-btn sm hud-btn"
                  onClick={toggleFullscreen}
                  title="Toggle Fullscreen (F)"
                >
                  {isFullscreen ? '[EXIT FULL]' : '[FULL]'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Playlist sidebar on the right side of the player when an episode is running */}
      {showPlaylist && playlistOpen && (
        <aside className="player-playlist-panel" aria-label="Episode Playlist">
          <div className="playlist-panel-header">
            <div className="playlist-header-title">
              <span className="playlist-header-label">PLAYLIST</span>
              <span className="playlist-header-count">
                {playlist.length} EPISODES
              </span>
            </div>
            <button
              type="button"
              className="brutalist-btn sm playlist-close-btn"
              onClick={() => setPlaylistOpen(false)}
              title="Close playlist panel"
            >
              ✕
            </button>
          </div>
          <div className="playlist-panel-list">
            {playlist.map((ep, idx) => {
              const isCurrent = ep.id === item.id;
              const epProgress = watchProgress[ep.id];
              const pct = epProgress?.percent ?? 0;

              return (
                <div
                  key={ep.id}
                  className={`playlist-row ${isCurrent ? 'active' : ''}`}
                  onClick={() => onSelectItem && onSelectItem(ep)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectItem && onSelectItem(ep);
                    }
                  }}
                >
                  <div className="playlist-row-index">
                    {isCurrent ? '▶' : `${idx + 1}`.padStart(2, '0')}
                  </div>
                  <div className="playlist-row-info">
                    <div className="playlist-row-title" title={ep.file_name}>
                      {ep.file_name}
                    </div>
                    <div className="playlist-row-meta">
                      {ep.metadata?.duration_seconds ? (
                        <span>{formatTime(ep.metadata.duration_seconds)}</span>
                      ) : null}
                      {pct > 0 && (
                        <span className="playlist-watched-tag">
                          {pct >= 90 ? 'WATCHED' : `${pct}%`}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
};
