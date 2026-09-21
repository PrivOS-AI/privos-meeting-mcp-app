/**
 * Settings › Microphone (plan.md § Settings item 3): permission status,
 * `enumerateDevices` picker persisted to `preferredMicDeviceId` (local pref —
 * mic choice is per-device/per-user, never workspace-wide), and the 3s test
 * wave (`mic-test-wave.tsx`).
 */
import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { loadLocalPreferences, saveLocalPreference } from '../../data/local-preferences.js';
import { MicTestWave } from '../../components/mic-test-wave.js';

type PermissionStatus = 'unknown' | 'granted' | 'denied' | 'prompt';
interface QueryablePermissionStatus {
  state: PermissionStatus;
  onchange: (() => void) | null;
}

export function MicrophonePanel() {
  const { t } = useI18n();
  const [deviceId, setDeviceId] = useState(() => loadLocalPreferences().preferredMicDeviceId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<PermissionStatus>('unknown');
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => setDevices(list.filter((d) => d.kind === 'audioinput')))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshDevices();
    const nav = navigator as Navigator & { permissions?: { query(desc: { name: string }): Promise<QueryablePermissionStatus> } };
    nav.permissions
      ?.query({ name: 'microphone' })
      .then((status) => {
        setPermission(status.state);
        status.onchange = () => setPermission(status.state);
      })
      .catch(() => setPermission('unknown'));
  }, [refreshDevices]);

  function onSelectDevice(id: string): void {
    setDeviceId(id);
    saveLocalPreference('preferredMicDeviceId', id);
  }

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.microphone.title')}</h3>

      <p className="ma-settings-panel__hint">{t(`settings.microphone.permission.${permission}`)}</p>

      <label className="ma-settings-field">
        <span>{t('settings.microphone.device')}</span>
        <select value={deviceId} onChange={(e) => onSelectDevice(e.target.value)}>
          <option value="">{t('settings.microphone.deviceDefault')}</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || t('settings.microphone.unnamedDevice')}
            </option>
          ))}
        </select>
      </label>

      <MicTestWave deviceId={deviceId || undefined} />

      {error ? (
        <p className="ma-settings-panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
