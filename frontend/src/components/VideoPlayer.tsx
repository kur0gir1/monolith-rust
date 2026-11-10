import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { MediaItem, ServerStatus, AudioTrack, SubtitleTrack } from '../types/media';
import { api } from '../api/client';
import { VideoProgressEntry } from '../utils/watchProgress';

interface VideoPlayerProps {
  item: MediaItem;
  serverStatus: ServerStatus | null;
  initialProgress?: VideoProgressEntry;
  onProgressUpdate?: (mediaId: string, currentTime: number, duration: number) => void;
  onBack: () => void;
}

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

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  item,
  initialProgress,
  onProgressUpdate,
  onBack,
}) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const initialResumeRef = useRef<number>(
    initialProgress && initialProgress.currentTime > 5 && initialProgress.percent < 96
      ? initialProgress.currentTime
      : 0
  );

  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number>(() => {
    return item.metadata?.audio_tracks?.[0]?.index ?? 0;
  });
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);
  const [streamStatus, setStreamStatus] = useState<string>('CONNECTING');
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isSwitchingAudio, setIsSwitchingAudio] = useState(false);

  // Embedded overlay & drawer states
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const [activePopover, setActivePopover] = useState<'none' | 'tracks' | 'subSettings'>('none');

  // Custom HUD transport state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(() => item.metadata?.duration_seconds ?? 0);
  const [bufferedEnd, setBufferedEnd] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
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

  // Initialize or reload HLS stream
  const initStream = useCallback(
    (audioIdx: number, resumeTime: number = 0) => {
      const video = videoRef.current;
      if (!video) return;

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      setStreamStatus('CONNECTING');
      setPlayerError(null);

      const streamUrl = api.getMasterStreamUrl(item.id, audioIdx);

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          startFragPrefetch: true,
          maxBufferLength: 30,
          backBufferLength: 30,
          manifestLoadingTimeOut: 15000,
          manifestLoadingMaxRetry: 6,
          manifestLoadingRetryDelay: 300,
        });
        hlsRef.current = hls;

        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setStreamStatus('STREAMING');
          if (resumeTime > 0) {
            video.currentTime = resumeTime;
          }
          video.play().catch((err) => {
            console.log('Autoplay prevented or waiting for interaction:', err);
          });
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            console.error('Fatal HLS error encountered:', data);
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                setStreamStatus('RETRYING NETWORK CHUNK...');
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                setStreamStatus('RECOVERING MEDIA BUFFER...');
                hls.recoverMediaError();
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
        video.src = streamUrl;
        video.addEventListener(
          'loadedmetadata',
          () => {
            setStreamStatus('STREAMING');
            if (resumeTime > 0) {
              video.currentTime = resumeTime;
            }
            video.play().catch(console.error);
          },
          { once: true }
        );
      } else {
        setPlayerError('FATAL: BROWSER ENVIRONMENT DOES NOT SUPPORT HLS PLAYBACK');
      }
    },
    [item.id]
  );

  // Initialize playback on mount or when media item changes
  useEffect(() => {
    const initialAudio = item.metadata?.audio_tracks?.[0]?.index ?? 0;
    setSelectedAudioIndex(initialAudio);
    setDuration(item.metadata?.duration_seconds ?? 0);
    const startAt = initialResumeRef.current;
    setCurrentTime(startAt);
    initStream(initialAudio, startAt);

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [initStream, item.id, item.metadata]);

  // Attach HTML5 video event listeners for custom HUD state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      setControlsVisible(true);
    };
    const onTimeUpdate = () => {
      const cur = video.currentTime;
      setCurrentTime(cur);
      if (video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1));
      }
      const metaDur = item.metadata?.duration_seconds ?? 0;
      const vidDur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const effDur = Math.max(metaDur, vidDur);
      if (effDur > 0 && cur > 1) {
        onProgressUpdate?.(item.id, cur, effDur);
      }
    };
    const onDurationChange = () => {
      const metaDur = item.metadata?.duration_seconds ?? 0;
      const vidDur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      setDuration(Math.max(metaDur, vidDur));
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('volumechange', onVolumeChange);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('volumechange', onVolumeChange);
    };
  }, [item.id, item.metadata?.duration_seconds, onProgressUpdate]);

  // Sync fullscreen state
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Transport actions
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(console.error);
    } else {
      video.pause();
    }
  }, []);

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const maxDur = duration > 0 ? duration : video.duration || 0;
      const next = Math.max(0, Math.min(maxDur || Infinity, video.currentTime + deltaSeconds));
      video.currentTime = next;
      setCurrentTime(next);
      resetControlsHideTimer();
    },
    [duration, resetControlsHideTimer]
  );

  const seekTo = useCallback((targetSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = targetSeconds;
    setCurrentTime(targetSeconds);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
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
    const resumePos = video ? video.currentTime : 0;

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
    <div className="player-container">
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
            autoPlay
          />

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
    </div>
  );
};
