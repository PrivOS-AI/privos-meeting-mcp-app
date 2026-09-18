/**
 * Settings › Microphone "Kiểm tra mic" button: opens its OWN short-lived
 * `getUserMedia` stream (never the recording stream — this runs outside any
 * meeting), draws a 3s live level bar via `AnalyserNode`, then releases every
 * track. Reuses the exact analyser technique `mic-level-meter.tsx` already
 * uses during recording, at component scope so both can evolve independently
 * without the recording meter depending on a test-only prop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';

const TEST_DURATION_MS = 3000;
const BAR_COUNT = 24;

export interface MicTestWaveProps {
  deviceId?: string;
}

export function MicTestWave({ deviceId }: MicTestWaveProps) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<number>(0);
  const stopRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  async function start(): Promise<void> {
    setError(null);
    setLevels(Array(BAR_COUNT).fill(0));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      setRunning(true);
      const AudioContextCtor = window.AudioContext;
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
        setLevels((prev) => [...prev.slice(1), Math.min(1, avg / 128)]);
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);

      stopRef.current = () => {
        source.disconnect();
        void audioContext.close();
        for (const track of stream.getTracks()) track.stop();
      };

      setTimeout(() => stop(), TEST_DURATION_MS);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="ma-mic-test">
      <button type="button" onClick={() => void start()} disabled={running}>
        {running ? t('settings.microphone.testing') : t('settings.microphone.testButton')}
      </button>
      <div className="ma-mic-test__wave" aria-hidden="true">
        {levels.map((level, i) => (
          <span key={i} className="ma-mic-test__bar" style={{ transform: `scaleY(${Math.max(0.06, level)})` }} />
        ))}
      </div>
      {error ? (
        <p className="ma-mic-test__error" role="alert">
          {t('settings.microphone.testError', { message: error })}
        </p>
      ) : null}
    </div>
  );
}
