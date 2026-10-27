/**
 * Settings › AI summary (plan.md § Settings item 5). Provider (Hub AI) and
 * model (`SUMMARY_MODEL`) are backend env config — read-only, no tool exposes
 * the model name to the iframe so this only states where it is configured.
 * `summaryLength`/`summaryLanguage` are per-room `app_settings` writes (room
 * owners, moderators, workspace admins) read by the post-meeting summary;
 * language `auto` keeps the meeting's own language. `liveSummaryMinutes` sets the
 * live panel's cadence while recording; `autoSendSummaryToChat` has the job post
 * the summary to the room as soon as it exists.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { LANGUAGE_ENDONYMS, SUPPORTED_LANGUAGES } from '../../i18n/languages.js';
import { loadWorkspaceSettings, saveWorkspaceSetting } from '../../data/settings-store.js';
import { LIVE_SUMMARY_MINUTES, type WorkspaceAppSettings } from '../../../shared/app-settings.js';
import { useCanManageRoomSettings } from './use-can-manage-room-settings.js';

export function AiSummaryPanel() {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t } = useI18n();
  const { canManage } = useCanManageRoomSettings();
  const [settings, setSettings] = useState<WorkspaceAppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    loadWorkspaceSettings(app, roomId)
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [app, roomId]);

  async function change<K extends 'summaryLength' | 'summaryLanguage' | 'liveSummaryMinutes' | 'autoSendSummaryToChat'>(key: K, value: WorkspaceAppSettings[K]): Promise<void> {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
    try {
      await saveWorkspaceSetting(app, key, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.aiSummary.title')}</h3>

      <div className="ma-settings-field ma-settings-field--readonly">
        <span>{t('settings.aiSummary.provider')}</span>
        <strong>Hub AI</strong>
      </div>
      <p className="ma-settings-panel__hint">{t('settings.aiSummary.modelHint')}</p>

      <h4 className="ma-settings-panel__subtitle">{t('settings.aiSummary.duringMeeting')}</h4>
      <label className="ma-settings-field">
        <span>{t('settings.aiSummary.liveEvery')}</span>
        <select
          value={settings?.liveSummaryMinutes ?? 5}
          disabled={!canManage || !settings}
          onChange={(e) => void change('liveSummaryMinutes', Number(e.target.value))}
        >
          {LIVE_SUMMARY_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? t('settings.aiSummary.liveManual') : t('settings.aiSummary.liveMinutes', { minutes })}
            </option>
          ))}
        </select>
      </label>
      <p className="ma-settings-panel__hint">{t('settings.aiSummary.liveHint')}</p>

      <h4 className="ma-settings-panel__subtitle">{t('settings.aiSummary.afterMeeting')}</h4>

      <label className="ma-settings-field">
        <span>{t('settings.aiSummary.length')}</span>
        <select
          value={settings?.summaryLength ?? 'normal'}
          disabled={!canManage || !settings}
          onChange={(e) => void change('summaryLength', e.target.value as WorkspaceAppSettings['summaryLength'])}
        >
          <option value="short">{t('settings.aiSummary.lengthShort')}</option>
          <option value="normal">{t('settings.aiSummary.lengthNormal')}</option>
          <option value="detailed">{t('settings.aiSummary.lengthDetailed')}</option>
        </select>
      </label>

      <label className="ma-settings-field">
        <span>{t('settings.aiSummary.language')}</span>
        <select
          value={settings?.summaryLanguage ?? 'auto'}
          disabled={!canManage || !settings}
          onChange={(e) => void change('summaryLanguage', e.target.value as WorkspaceAppSettings['summaryLanguage'])}
        >
          <option value="auto">{t('settings.aiSummary.languageAuto')}</option>
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {LANGUAGE_ENDONYMS[code]}
            </option>
          ))}
        </select>
      </label>

      <label className="ma-settings-field ma-settings-field--checkbox">
        <input
          type="checkbox"
          checked={settings?.autoSendSummaryToChat ?? false}
          disabled={!canManage || !settings}
          onChange={(e) => void change('autoSendSummaryToChat', e.target.checked)}
        />
        <span>{t('settings.aiSummary.autoSend')}</span>
      </label>
      <p className="ma-settings-panel__hint">{t('settings.aiSummary.autoSendHint')}</p>

      {!canManage ? <p className="ma-settings-panel__hint">{t('settings.adminOnlyNote')}</p> : null}
      {error ? (
        <p className="ma-settings-panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
