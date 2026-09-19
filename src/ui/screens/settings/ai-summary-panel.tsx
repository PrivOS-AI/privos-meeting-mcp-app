/**
 * Settings › AI summary (plan.md § Settings item 5). Provider (Hub AI) and
 * model (`SUMMARY_MODEL`) are backend env config — read-only, no tool exposes
 * the model name to the iframe so this only states where it is configured.
 * `summaryLength`/`summaryLanguage` are real `app_settings` writes, admin-only.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { loadWorkspaceSettings, saveWorkspaceSetting } from '../../data/settings-store.js';
import type { WorkspaceAppSettings } from '../../../shared/app-settings.js';
import { useWorkspaceAdmin } from './use-workspace-admin.js';

export function AiSummaryPanel() {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t } = useI18n();
  const { isAdmin } = useWorkspaceAdmin();
  const [settings, setSettings] = useState<WorkspaceAppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    loadWorkspaceSettings(app, roomId)
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [app, roomId]);

  async function change<K extends 'summaryLength' | 'summaryLanguage'>(key: K, value: WorkspaceAppSettings[K]): Promise<void> {
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

      <label className="ma-settings-field">
        <span>{t('settings.aiSummary.length')}</span>
        <select
          value={settings?.summaryLength ?? 'normal'}
          disabled={!isAdmin || !settings}
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
          value={settings?.summaryLanguage ?? 'vi'}
          disabled={!isAdmin || !settings}
          onChange={(e) => void change('summaryLanguage', e.target.value as WorkspaceAppSettings['summaryLanguage'])}
        >
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
      </label>

      {!isAdmin ? <p className="ma-settings-panel__hint">{t('settings.adminOnlyNote')}</p> : null}
      {error ? (
        <p className="ma-settings-panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
