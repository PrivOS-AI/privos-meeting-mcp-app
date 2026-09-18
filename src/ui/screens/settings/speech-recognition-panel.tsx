/**
 * Settings › Speech recognition (plan.md § Settings item 2, QĐ-08): no API
 * key input field, ever. Two admin-only selects (realtime/async provider)
 * write through `meeting_settings_set`; the status table comes straight from
 * `meeting_stt_status`, which itself decides how much detail to return based
 * on whether the caller is a workspace admin (`{ok}` only for everyone else)
 * — this panel simply renders whatever shape it gets back rather than trying
 * to duplicate that admin check client-side.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp } from '@privos_ai/app-react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { saveWorkspaceSetting } from '../../data/settings-store.js';
import type { WorkspaceAppSettings } from '../../../shared/app-settings.js';

interface ProviderStatusDto {
  provider: 'soniox' | 'elevenlabs';
  kind: 'realtime' | 'async';
  configured: boolean;
  ok: boolean;
  models: string[];
  detail?: string;
  reason?: string;
  usage?: { tier?: string; characterCount?: number; characterLimit?: number };
}

interface SttStatusAdmin {
  ok: true;
  activeRealtimeProvider: 'soniox' | 'elevenlabs';
  activeAsyncProvider: 'soniox' | 'elevenlabs';
  providers: ProviderStatusDto[];
  liveConcurrency: { active?: number; max: number };
  checkedAt: string;
}

interface SttStatusMember {
  ok: boolean;
}

type SttStatus = SttStatusAdmin | SttStatusMember;

function isAdminStatus(status: SttStatus): status is SttStatusAdmin {
  return 'providers' in status;
}

export function SpeechRecognitionPanel() {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [status, setStatus] = useState<SttStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    app
      .callServerTool({ name: 'meeting_stt_status', arguments: {} })
      .then((raw) => setStatus(parseToolResult(raw) as unknown as SttStatus))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [app]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function changeProvider(key: 'sttRealtimeProvider' | 'sttAsyncProvider', value: WorkspaceAppSettings['sttRealtimeProvider']): Promise<void> {
    setSaving(key);
    setError(null);
    try {
      await saveWorkspaceSetting(app, key, value);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  if (loading && !status) return <p>{t('settings.speech.loading')}</p>;
  if (!status) return <p className="ma-settings-panel__error">{error ?? t('settings.speech.loading')}</p>;

  if (!isAdminStatus(status)) {
    return (
      <section className="ma-settings-panel">
        <h3 className="ma-settings-panel__title">{t('settings.speech.title')}</h3>
        <p>{status.ok ? t('settings.speech.memberOk') : t('settings.speech.memberDown')}</p>
        <p className="ma-settings-panel__hint">{t('settings.speech.adminOnly')}</p>
      </section>
    );
  }

  const byKind = (kind: 'realtime' | 'async') => status.providers.filter((p) => p.kind === kind);

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.speech.title')}</h3>
      <p className="ma-settings-panel__hint">{t('settings.speech.noApiKeyNote')}</p>

      <label className="ma-settings-field">
        <span>{t('settings.speech.realtimeProvider')}</span>
        <select
          value={status.activeRealtimeProvider}
          disabled={saving === 'sttRealtimeProvider'}
          onChange={(e) => void changeProvider('sttRealtimeProvider', e.target.value as WorkspaceAppSettings['sttRealtimeProvider'])}
        >
          <option value="soniox">Soniox — {t('settings.speech.hasSpeakerLabels')}</option>
          <option value="elevenlabs">ElevenLabs — {t('settings.speech.noSpeakerLabels')}</option>
        </select>
      </label>
      {status.activeRealtimeProvider === 'elevenlabs' ? <p className="ma-settings-panel__warning">{t('settings.speech.elevenlabsRealtimeWarning')}</p> : null}

      <label className="ma-settings-field">
        <span>{t('settings.speech.asyncProvider')}</span>
        <select
          value={status.activeAsyncProvider}
          disabled={saving === 'sttAsyncProvider'}
          onChange={(e) => void changeProvider('sttAsyncProvider', e.target.value as WorkspaceAppSettings['sttAsyncProvider'])}
        >
          <option value="soniox">Soniox</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>
      </label>
      <p className="ma-settings-panel__hint">{t('settings.speech.changeAppliesToNewMeetings')}</p>

      <div className="ma-settings-panel__actions">
        <button type="button" onClick={reload} disabled={loading}>
          {t('settings.speech.testConnection')}
        </button>
        <span className="ma-settings-panel__hint">
          {t('settings.speech.concurrency', { active: status.liveConcurrency.active ?? '?', max: status.liveConcurrency.max })}
        </span>
      </div>

      {error ? (
        <p className="ma-settings-panel__error" role="alert">
          {error}
        </p>
      ) : null}

      <table className="ma-settings-table">
        <thead>
          <tr>
            <th>{t('settings.speech.colKind')}</th>
            <th>{t('settings.speech.colProvider')}</th>
            <th>{t('settings.speech.colStatus')}</th>
            <th>{t('settings.speech.colModel')}</th>
            <th>{t('settings.speech.colUsage')}</th>
          </tr>
        </thead>
        <tbody>
          {(['realtime', 'async'] as const).flatMap((kind) =>
            byKind(kind).map((p) => (
              <tr key={`${kind}-${p.provider}`}>
                <td>{t(`settings.speech.kind.${kind}`)}</td>
                <td>{p.provider}</td>
                <td>
                  {!p.configured
                    ? t('settings.speech.statusNotConfigured')
                    : p.ok
                      ? t('settings.speech.statusOk')
                      : t('settings.speech.statusFailed', { reason: p.reason ?? p.detail ?? '' })}
                </td>
                <td>{p.models.join(', ')}</td>
                <td>{p.usage?.characterCount != null ? `${p.usage.characterCount}/${p.usage.characterLimit ?? '?'} (${p.usage.tier ?? '—'})` : '—'}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>

      <p className="ma-settings-panel__hint">{t('settings.speech.keyNote')}</p>
    </section>
  );
}
