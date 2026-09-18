/**
 * Small live mic-level bar. A read-only `AnalyserNode` tap on the SAME
 * `MediaStream` used for recording/captions — it only *listens*, never sends
 * anything, so it does not touch the wire protocol QĐ-01 forbids touching.
 */
import { useEffect, useRef, useState } from 'react';

export interface MicLevelMeterProps {
  stream: MediaStream | null;
  muted: boolean;
}

export function MicLevelMeter({ stream, muted }: MicLevelMeterProps) {
  const [level, setLevel] = useState(0);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!stream || muted) {
      setLevel(0);
      return;
    }
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) return;
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      setLevel(Math.min(1, avg / 128));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameRef.current);
      source.disconnect();
      void audioContext.close();
    };
  }, [stream, muted]);

  return (
    <div className="ma-mic-meter" aria-hidden="true">
      <div className="ma-mic-meter__fill" style={{ transform: `scaleX(${muted ? 0 : level})` }} />
    </div>
  );
}
