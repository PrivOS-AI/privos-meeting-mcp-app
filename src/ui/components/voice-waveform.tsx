/**
 * Live voice waveform for the recording screen. A read-only `AnalyserNode` tap
 * on the SAME `MediaStream` used for recording/captions (it only listens — it
 * never touches the wire protocol), rendered on a canvas as one flowing line
 * PER SPEAKER, each in that speaker's colour:
 *
 *  - amplitude follows the real mic level; the level is credited to whoever is
 *    speaking right now, every other speaker's line relaxes back to a hairline;
 *  - both ends taper to a point (a sine window), so the wave swells in the
 *    middle and closes at the edges;
 *  - the head (right end) carries a glowing dot that pulses with the level.
 *
 * Honors `prefers-reduced-motion` (no travelling phase, no pulse).
 */
import { useEffect, useRef } from 'react';

export interface WaveformSpeaker {
  speakerKey: string;
  colorKey: string;
}

export interface VoiceWaveformProps {
  stream: MediaStream | null;
  muted: boolean;
  speakers: readonly WaveformSpeaker[];
  /** Who is speaking right now (effective speaker of the newest caption); undefined → the neutral mic line. */
  activeKey?: string;
}

/** Same hues as the speaker avatars, as concrete colours the canvas can stroke. */
const SPEAKER_COLORS: Record<string, string> = {
  blue: '#3C82E6',
  gold: '#E5A800',
  green: '#1F9E6F',
  purple: '#7C5CD6',
  red: '#DB4B4B',
  coral: '#E0685A',
  teal: '#1FA3A3',
};
const NEUTRAL_KEY = '__mic__';
const HISTORY = 96; // samples kept per line (~3s at 30fps)

function colorOf(colorKey: string): string {
  return SPEAKER_COLORS[colorKey] ?? SPEAKER_COLORS.blue;
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function VoiceWaveform({ stream, muted, speakers, activeKey }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Latest props for the animation loop, so the audio graph is not rebuilt on every caption.
  const liveRef = useRef({ speakers, activeKey, muted });
  liveRef.current = { speakers, activeKey, muted };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx2d = canvas?.getContext('2d');
    if (!canvas || !ctx2d) return undefined;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let analyser: AnalyserNode | null = null;
    let audioContext: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    if (stream && window.AudioContext) {
      audioContext = new AudioContext();
      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
    }
    const samples = new Uint8Array(analyser?.fftSize ?? 1024);
    const histories = new Map<string, Float32Array>();
    let level = 0;
    let phase = 0;
    let frame = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);

    const readLevel = (): number => {
      if (!analyser || liveRef.current.muted) return 0;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      // RMS → perceptual-ish 0..1 (speech RMS is small; lift it, then clamp).
      return Math.min(1, Math.sqrt(sum / samples.length) * 4.2);
    };

    const drawLine = (history: Float32Array, color: string, active: boolean, width: number, height: number) => {
      const mid = height / 2;
      const reach = mid - 5;
      const step = 3;
      ctx2d.beginPath();
      for (let x = 0; x <= width; x += step) {
        const u = x / width;
        const pos = u * (HISTORY - 1);
        const i0 = Math.floor(pos);
        const amp = history[i0] + (history[Math.min(HISTORY - 1, i0 + 1)] - history[i0]) * (pos - i0);
        const taper = Math.pow(Math.sin(Math.PI * u), 0.75); // closes to a point at both ends
        const carrier = Math.sin(u * 17 - phase) * 0.62 + Math.sin(u * 31 - phase * 1.7) * 0.38;
        const idle = active ? 0 : 0.015;
        const y = mid + (amp + idle) * taper * reach * carrier;
        if (x === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
      }
      const gradient = ctx2d.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, withAlpha(color, 0));
      gradient.addColorStop(0.18, withAlpha(color, active ? 0.55 : 0.18));
      gradient.addColorStop(0.85, withAlpha(color, active ? 1 : 0.3));
      gradient.addColorStop(1, withAlpha(color, active ? 0.9 : 0.12));
      ctx2d.strokeStyle = gradient;
      ctx2d.lineWidth = active ? 2.4 : 1.2;
      ctx2d.lineJoin = 'round';
      ctx2d.lineCap = 'round';
      ctx2d.shadowColor = withAlpha(color, active ? 0.65 : 0);
      ctx2d.shadowBlur = active ? 12 : 0;
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;
    };

    const tick = () => {
      const { speakers: currentSpeakers, activeKey: currentActive } = liveRef.current;
      const { width, height } = canvas.getBoundingClientRect();
      // Fast attack, slow release — reads as speech rather than flicker.
      const target = readLevel();
      level += (target - level) * (target > level ? 0.55 : 0.12);
      if (!reducedMotion) phase += 0.11 + level * 0.22;

      const lines = currentSpeakers.length > 0 ? currentSpeakers : [{ speakerKey: NEUTRAL_KEY, colorKey: 'blue' }];
      const active = lines.some((l) => l.speakerKey === currentActive) ? currentActive : lines.length === 1 ? lines[0].speakerKey : undefined;
      for (const line of lines) {
        let history = histories.get(line.speakerKey);
        if (!history) {
          history = new Float32Array(HISTORY);
          histories.set(line.speakerKey, history);
        }
        history.copyWithin(0, 1);
        // The level belongs to whoever is speaking; everyone else relaxes to flat.
        history[HISTORY - 1] = line.speakerKey === active ? level : history[HISTORY - 2] * 0.86;
      }

      ctx2d.clearRect(0, 0, width, height);
      for (const line of lines) if (line.speakerKey !== active) drawLine(histories.get(line.speakerKey)!, colorOf(line.colorKey), false, width, height);
      const activeLine = lines.find((l) => l.speakerKey === active);
      if (activeLine) {
        const color = colorOf(activeLine.colorKey);
        drawLine(histories.get(activeLine.speakerKey)!, color, true, width, height);
        // Glowing head at the end of the sound.
        const pulse = reducedMotion ? 0.5 : level;
        const headX = width - 6;
        const headY = height / 2;
        const halo = ctx2d.createRadialGradient(headX, headY, 0, headX, headY, 10 + pulse * 12);
        halo.addColorStop(0, withAlpha(color, 0.55));
        halo.addColorStop(1, withAlpha(color, 0));
        ctx2d.fillStyle = halo;
        ctx2d.beginPath();
        ctx2d.arc(headX, headY, 10 + pulse * 12, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.fillStyle = '#ffffff';
        ctx2d.shadowColor = color;
        ctx2d.shadowBlur = 10 + pulse * 10;
        ctx2d.beginPath();
        ctx2d.arc(headX, headY, 2.6 + pulse * 1.6, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.shadowBlur = 0;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      source?.disconnect();
      void audioContext?.close();
    };
  }, [stream]);

  return <canvas ref={canvasRef} className={`ma-voice-wave${muted ? ' ma-voice-wave--muted' : ''}`} aria-hidden="true" />;
}
