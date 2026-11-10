import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { MediaItem, ServerStatus, AudioTrack, SubtitleTrack } from '../types/media';
import { api } from '../api/client';

interface VideoPlayerProps {
  item: MediaItem;
  serverStatus: ServerStatus | null;
  onBack: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  item,
  serverStatus,
  onBack,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number>(() => {
    return item.metadata?.audio_tracks?.[0]?.index ?? 0;
  });
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null);
  const [streamStatus, setStreamStatus] = useState<string>('CONNECTING');
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isSwitchingAudio, setIsSwitchingAudio] = useState(false);

  const audioTracks: AudioTrack[] = item.metadata?.audio_tracks ?? [];
  const subtitleTracks: SubtitleTrack[] = item.metadata?.subtitle_tracks ?? [];

  // Transcoder badge string
  const transcoderBadge = serverStatus?.transcoder
    ? `[TRANSCODE: ${serverStatus.transcoder.toUpperCase()}]`
    : serverStatus?.gpu_available
    ? '[TRANSCODE: NVENC CUDA]'
    : '[TRANSCODE: CPU LIBX264]';

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
          maxBufferLength: 30,
          backBufferLength: 30,
          manifestLoadingTimeOut: 15000,
          manifestLoadingMaxRetry: 5,
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
        // Native HLS fallback (Safari/iOS)
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

  // Initialize playback on mount (or when media item changes)
  useEffect(() => {
    const initialAudio = item.metadata?.audio_tracks?.[0]?.index ?? 0;
    setSelectedAudioIndex(initialAudio);
    initStream(initialAudio, 0);

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [initStream, item.id, item.metadata]);

  // Handle Subtitle track switching
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Remove existing dynamic subtitle tracks
    const existingTracks = video.querySelectorAll('track');
    existingTracks.forEach((t) => t.remove());

    if (selectedSubtitleIndex !== null) {
      const sub = subtitleTracks.find((s) => s.index === selectedSubtitleIndex);
      if (sub) {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = sub.title || sub.language?.toUpperCase() || `TRACK ${sub.index}`;
        track.srclang = sub.language || 'en';
        track.src = api.getSubtitleUrl(item.id, sub.index);
        track.default = true;

        track.addEventListener('load', () => {
          for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = 'showing';
          }
        });

        video.appendChild(track);
      }
    } else {
      // Disable all subtitle tracks
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
      // Notify backend to remap audio track
      await api.switchAudioTrack(item.id, index);
    } catch (err) {
      console.warn('Backend audio switch notification failed (will reload stream URL):', err);
    }

    const video = videoRef.current;
    const currentTime = video ? video.currentTime : 0;

    setSelectedAudioIndex(index);
    initStream(index, currentTime);
    setIsSwitchingAudio(false);
  };

  return (
    <div className="player-container">
      {/* Player Header */}
      <div className="player-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button type="button" className="brutalist-btn" onClick={onBack}>
            [&lt; RETURN TO BROWSER]
          </button>
          <div className="player-title">NOW STREAMING: {item.file_name}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="badge badge-inverted">{transcoderBadge}</span>
          <span className="badge">[STATE: {streamStatus}]</span>
        </div>
      </div>

      {/* Video Element */}
      <div className="player-video-wrapper">
        <video
          ref={videoRef}
          className="player-video-element"
          controls
          playsInline
          autoPlay
        />
        {playerError && (
          <div
            style={{
              position: 'absolute',
              background: '#000000',
              border: '2px solid #FFFFFF',
              padding: '20px',
              maxWidth: '80%',
              textAlign: 'center',
            }}
          >
            <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>[STREAM ERROR]</h3>
            <p style={{ fontSize: '0.8rem' }}>{playerError}</p>
            <button
              type="button"
              className="brutalist-btn badge-inverted"
              style={{ marginTop: '12px' }}
              onClick={() => initStream(selectedAudioIndex, 0)}
            >
              [RETRY STREAM]
            </button>
          </div>
        )}
      </div>

      {/* Dynamic Controls Grid: Audio & Subtitle Track Selectors */}
      <div className="player-controls-grid">
        {/* Audio Track Selector */}
        <div className="control-panel">
          <div className="control-panel-title">
            <span>[AUDIO TRACK ROUTING]</span>
            <span className="badge">
              ACTIVE: #{selectedAudioIndex} ({audioTracks.find((a) => a.index === selectedAudioIndex)?.language?.toUpperCase() || 'DEFAULT'})
            </span>
          </div>

          <div className="track-list">
            {audioTracks.length > 0 ? (
              audioTracks.map((track) => (
                <div
                  key={track.index}
                  className={`track-item ${track.index === selectedAudioIndex ? 'selected' : ''}`}
                  onClick={() => handleSelectAudio(track.index)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleSelectAudio(track.index);
                    }
                  }}
                >
                  <div>
                    <strong>TRACK #{track.index}:</strong> {track.title || track.codec.toUpperCase()} [
                    {track.language ? track.language.toUpperCase() : 'UND'}]
                  </div>
                  <div>
                    {track.channels}CH {track.channel_layout ? `(${track.channel_layout})` : ''}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ opacity: 0.7, padding: '8px' }}>
                [NO MULTIPLE AUDIO TRACKS DETECTED]
              </div>
            )}
          </div>
        </div>

        {/* Subtitle Track Selector */}
        <div className="control-panel">
          <div className="control-panel-title">
            <span>[SUBTITLE TRACK ROUTING]</span>
            <span className="badge">
              ACTIVE: {selectedSubtitleIndex !== null ? `#${selectedSubtitleIndex}` : '[OFF]'}
            </span>
          </div>

          <div className="track-list">
            <div
              className={`track-item ${selectedSubtitleIndex === null ? 'selected' : ''}`}
              onClick={() => setSelectedSubtitleIndex(null)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setSelectedSubtitleIndex(null);
                }
              }}
            >
              <strong>[DISABLE SUBTITLES]</strong>
              <span>OFF</span>
            </div>

            {subtitleTracks.map((sub) => (
              <div
                key={sub.index}
                className={`track-item ${selectedSubtitleIndex === sub.index ? 'selected' : ''}`}
                style={sub.is_bitmap ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                onClick={() => {
                  if (!sub.is_bitmap) setSelectedSubtitleIndex(sub.index);
                }}
                role="button"
                tabIndex={sub.is_bitmap ? -1 : 0}
                aria-disabled={sub.is_bitmap}
                onKeyDown={(e) => {
                  if (!sub.is_bitmap && (e.key === 'Enter' || e.key === ' ')) {
                    setSelectedSubtitleIndex(sub.index);
                  }
                }}
              >
                <div>
                  <strong>TRACK #{sub.index}:</strong> {sub.title || sub.codec.toUpperCase()} [
                  {sub.language ? sub.language.toUpperCase() : 'UND'}]
                </div>
                <div>
                  {sub.is_bitmap
                    ? '[BITMAP / UNSUPPORTED]'
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
  );
};
