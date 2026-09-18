/**
 * Presigned-URL `<audio>` player (phase-07 § Architecture): play/pause,
 * scrubber with bookmark ticks, mm:ss/mm:ss, 1x/1.25x/1.5x/2x speed cycle,
 * and an imperative `seek()` other panels (transcript lines, action-item
 * timestamps) call through `ref`. `onError` fires once per playback error so
 * the caller can re-resolve an expired presigned URL and retry — this
 * component has no Files knowledge of its own, it only plays `src`.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent } from 'react';

import { formatClock } from '../data/format-time.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface AudioPlayerHandle {
  seek(sec: number): void;
  play(): void;
  pause(): void;
}

export interface AudioPlayerBookmarkTick {
  id: string;
  atSec: number;
}

export interface AudioPlayerProps {
  src: string;
  bookmarks?: AudioPlayerBookmarkTick[];
  onTimeUpdate?(sec: number): void;
  onError?(): void;
}

const RATES = [1, 1.25, 1.5, 2];

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(function AudioPlayer({ src, bookmarks = [], onTimeUpdate, onError }, ref) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [rate, setRate] = useState(1);

  useImperativeHandle(
    ref,
    () => ({
      seek(sec: number) {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, sec);
        setCurrentSec(audio.currentTime);
      },
      play() {
        void audioRef.current?.play();
      },
      pause() {
        audioRef.current?.pause();
      },
    }),
    [],
  );

  // rAF loop drives the scrubber/time display and `onTimeUpdate` (transcript active-line highlight) at animation
  // rate rather than the `<audio>` element's coarser native `timeupdate` event (phase-07 § Architecture).
  useEffect(() => {
    let raf = 0;
    function tick(): void {
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        setCurrentSec(audio.currentTime);
        onTimeUpdate?.(audio.currentTime);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onTimeUpdate]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  function togglePlay(): void {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  function onScrub(event: ChangeEvent<HTMLInputElement>): void {
    const sec = Number(event.target.value);
    if (audioRef.current) audioRef.current.currentTime = sec;
    setCurrentSec(sec);
  }

  function cycleRate(): void {
    setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]);
  }

  return (
    <div className="ma-audio-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => setDurationSec(event.currentTarget.duration || 0)}
        onError={() => onError?.()}
      />
      <button type="button" className="ma-audio-player__toggle" onClick={togglePlay} aria-label={playing ? t('player.pause') : t('player.play')}>
        <Icon name={playing ? 'pause' : 'play'} size={18} />
      </button>
      <div className="ma-audio-player__scrub-wrap">
        <input
          type="range"
          className="ma-audio-player__scrub"
          min={0}
          max={durationSec || 0}
          step={0.1}
          value={Math.min(currentSec, durationSec || currentSec)}
          onChange={onScrub}
          aria-label={t('player.scrubber')}
        />
        <div className="ma-audio-player__ticks" aria-hidden="true">
          {bookmarks.map((bookmark) => (
            <span key={bookmark.id} className="ma-audio-player__tick" style={{ left: durationSec > 0 ? `${(bookmark.atSec / durationSec) * 100}%` : '0%' }} />
          ))}
        </div>
      </div>
      <span className="ma-audio-player__time">
        {formatClock(currentSec)} / {formatClock(durationSec)}
      </span>
      <button type="button" className="ma-audio-player__rate" onClick={cycleRate} aria-label={t('player.rate')}>
        {rate}x
      </button>
    </div>
  );
});
