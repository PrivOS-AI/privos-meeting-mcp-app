/**
 * Settings › Speech recognition (plan.md § Settings item 2, D-08): no API
 * key input field, ever. Two admin-only groups of provider cards (live
 * captions / after the meeting) write through `meeting_settings_set`; each
 * card's readiness comes straight from
 * `meeting_stt_status`, which itself decides how much detail to return based
 * on whether the caller is a workspace admin (`{ok}` only for everyone else)
 * — this panel simply renders whatever shape it gets back rather than trying
 * to duplicate that admin check client-side.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp } from '@privos_ai/app-react';

import { Icon } from '../../components/icon.js';
import { useI18n } from '../../i18n/i18n-provider.js';
import { saveWorkspaceSetting } from '../../data/settings-store.js';
import type { WorkspaceAppSettings } from '../../../shared/app-settings.js';

interface ProviderStatusDto {
  provider: 'local' | 'soniox' | 'elevenlabs';
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
  activeRealtimeProvider: 'local' | 'soniox' | 'elevenlabs';
  activeAsyncProvider: 'local' | 'soniox' | 'elevenlabs';
  providers: ProviderStatusDto[];
  liveConcurrency: { active?: number; max: number };
  checkedAt: string;
}

interface SttStatusMember {
  ok: boolean;
}

type SttStatus = SttStatusAdmin | SttStatusMember;

type Vendor = 'local' | 'soniox' | 'elevenlabs';
type ProviderKind = 'realtime' | 'async';

const VENDORS: readonly Vendor[] = ['local', 'soniox', 'elevenlabs'];

/** What each provider is good at, per role: the tags on its card. */
const VENDOR_TAGS: Record<Vendor, Record<ProviderKind, string[]>> = {
  local: { realtime: ['private', 'viEn', 'free'], async: ['private', 'viEn', 'speakers', 'free'] },
  soniox: { realtime: ['cloud', 'manyLanguages', 'liveSpeakers'], async: ['cloud', 'manyLanguages', 'speakers'] },
  elevenlabs: { realtime: ['cloud', 'manyLanguages'], async: ['cloud', 'manyLanguages', 'speakers'] },
};

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

  const statusOf = (kind: ProviderKind, vendor: Vendor) => status.providers.find((p) => p.kind === kind && p.provider === vendor);

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.speech.title')}</h3>

      {(['realtime', 'async'] as const).map((kind) => {
        const settingKey = kind === 'realtime' ? 'sttRealtimeProvider' : 'sttAsyncProvider';
        const active = kind === 'realtime' ? status.activeRealtimeProvider : status.activeAsyncProvider;
        return (
          <fieldset key={kind} className="ma-provider-group" disabled={saving === settingKey}>
            <legend className="ma-provider-group__title">{t(`settings.speech.section.${kind}`)}</legend>
            <p className="ma-settings-panel__hint">{t(`settings.speech.section.${kind}Hint`)}</p>
            <div className="ma-provider-cards">
              {VENDORS.map((vendor) => {
                const providerStatus = statusOf(kind, vendor);
                // The built-in provider needs no key; a missing status row means it was not reported, not that it is down.
                const ready = vendor === 'local' ? providerStatus?.ok !== false : Boolean(providerStatus?.configured && providerStatus.ok);
                const selected = active === vendor;
                const state = selected ? 'active' : ready ? 'ready' : !providerStatus?.configured ? 'notConfigured' : 'failed';
                return (
                  <label key={vendor} className={`ma-provider-card${selected ? ' ma-provider-card--selected' : ''}${!ready && !selected ? ' ma-provider-card--unavailable' : ''}`}>
                    <input
                      type="radio"
                      className="ma-visually-hidden"
                      name={`provider-${kind}`}
                      value={vendor}
                      checked={selected}
                      disabled={!ready && !selected}
                      onChange={() => void changeProvider(settingKey, vendor)}
                    />
                    <span className="ma-provider-card__head">
                      <span className="ma-provider-card__name">
                        <Icon name={vendor === 'local' ? 'shield-keyhole' : 'globe'} size={16} />
                        {t(`settings.speech.vendor.${vendor}.name`)}
                      </span>
                      <span className={`ma-provider-card__state ma-provider-card__state--${state}`}>
                        {selected ? <Icon name="checkmark-circle" size={14} /> : null}
                        {t(`settings.speech.state.${state}`)}
                      </span>
                    </span>
                    <span className="ma-provider-card__desc">{t(`settings.speech.vendor.${vendor}.${kind}`)}</span>
                    <span className="ma-provider-card__tags">
                      {VENDOR_TAGS[vendor][kind].map((tag) => (
                        <span key={tag} className="ma-provider-card__tag">
                          {t(`settings.speech.tag.${tag}`)}
                        </span>
                      ))}
                    </span>
                    {state === 'notConfigured' ? (
                      <span className="ma-provider-card__note">{t('settings.speech.needsKey')}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      {status.activeRealtimeProvider === 'elevenlabs' ? <p className="ma-settings-panel__warning">{t('settings.speech.elevenlabsRealtimeWarning')}</p> : null}
      <p className="ma-settings-panel__hint">{t('settings.speech.changeAppliesToNewMeetings')}</p>

      <div className="ma-provider-health">
        <span className="ma-provider-health__usage">
          <Icon name="person-multiple" size={16} />
          {t('settings.speech.concurrency', { active: status.liveConcurrency.active ?? '?', max: status.liveConcurrency.max })}
        </span>
        <button type="button" className="ma-provider-health__check" onClick={reload} disabled={loading}>
          {loading ? t('settings.speech.loading') : t('settings.speech.testConnection')}
        </button>
      </div>

      {error ? (
        <p className="ma-settings-panel__error" role="alert">
          {error}
        </p>
      ) : null}

      <details className="ma-provider-details">
        <summary>{t('settings.speech.details')}</summary>
        <ul>
          {status.providers.map((p) => (
            <li key={`${p.kind}-${p.provider}`}>
              <strong>
                {t(`settings.speech.vendor.${p.provider}.name`)} · {t(`settings.speech.kind.${p.kind}`)}
              </strong>
              {': '}
              {!p.configured
                ? t('settings.speech.statusNotConfigured')
                : p.ok
                  ? t('settings.speech.statusOk')
                  : t('settings.speech.statusFailed', { reason: p.reason ?? p.detail ?? '' })}
              {p.models.length ? <span className="ma-provider-details__models">{p.models.join(', ')}</span> : null}
              {p.usage?.characterCount != null ? (
                <span className="ma-provider-details__models">
                  {p.usage.characterCount}/{p.usage.characterLimit ?? '?'} ({p.usage.tier ?? '—'})
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="ma-settings-panel__hint">{t('settings.speech.keyNote')}</p>
      </details>
    </section>
  );
}
