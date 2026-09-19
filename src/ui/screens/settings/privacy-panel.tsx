/**
 * Settings › Privacy & storage (plan.md § Settings item 6). `keepOriginalAudio`
 * (default off) and `autoDeleteAudioDays`/`interruptedPartsRetentionDays` are
 * real `app_settings` writes (admin-only — they set the DEFAULT/retention
 * window for every future meeting in the workspace). "Xoá toàn bộ voiceprint"
 * has no dedicated bulk tool — it lists every profile (`speaker_profile_list`,
 * open to any verified user) and deletes each one (`speaker_profile_delete`,
 * gated server-side to the creator or an admin — a non-admin's delete calls
 * simply fail per-row and are reported, not silently skipped).
 *
 * plan.md asks for a "type the name back" confirmation without specifying
 * what to type for a BULK action (no single profile name applies) — resolved
 * here with a fixed confirmation phrase (plan default: explicit, typed,
 * irreversible-action gate), documented inline rather than left ambiguous.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { loadWorkspaceSettings, saveWorkspaceSetting } from '../../data/settings-store.js';
import { speakerProfileDelete, speakerProfileList } from '../../data/speaker-api.js';
import type { WorkspaceAppSettings } from '../../../shared/app-settings.js';
import { useWorkspaceAdmin } from './use-workspace-admin.js';
import publisherManifest from '../../../../privos-app.json';

/** Must be typed verbatim (case-insensitive) to enable the bulk-delete button — see file header. */
const CONFIRM_PHRASE = 'XOA VOICEPRINT';

export function PrivacyPanel() {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t } = useI18n();
  const { isAdmin } = useWorkspaceAdmin();
  const [settings, setSettings] = useState<WorkspaceAppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    loadWorkspaceSettings(app, roomId)
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [app, roomId]);

  async function change<K extends 'keepOriginalAudio' | 'autoDeleteAudioDays' | 'interruptedPartsRetentionDays'>(
    key: K,
    value: WorkspaceAppSettings[K],
  ): Promise<void> {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
    try {
      await saveWorkspaceSetting(app, key, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteAllVoiceprints(): Promise<void> {
    setDeleting(true);
    setDeleteResult(null);
    setError(null);
    try {
      const profiles = await speakerProfileList(app);
      let deleted = 0;
      let failed = 0;
      for (const profile of profiles) {
        try {
          await speakerProfileDelete(app, profile.id);
          deleted++;
        } catch {
          failed++;
        }
      }
      setDeleteResult(t('settings.privacy.deleteAllResult', { deleted, failed }));
      setConfirmText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  const dataPolicy = (publisherManifest as { dataPolicy?: { retention?: string } }).dataPolicy;
  const confirmed = confirmText.trim().toUpperCase() === CONFIRM_PHRASE;

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.privacy.title')}</h3>

      <label className="ma-settings-field ma-settings-field--checkbox">
        <input
          type="checkbox"
          checked={settings?.keepOriginalAudio ?? false}
          disabled={!isAdmin || !settings}
          onChange={(e) => void change('keepOriginalAudio', e.target.checked)}
        />
        <span>{t('settings.privacy.keepAudio')}</span>
      </label>

      <label className="ma-settings-field">
        <span>{t('settings.privacy.autoDeleteDays')}</span>
        <input
          type="number"
          min={0}
          value={settings?.autoDeleteAudioDays ?? 90}
          disabled={!isAdmin || !settings}
          onChange={(e) => void change('autoDeleteAudioDays', Math.max(0, Math.round(Number(e.target.value) || 0)))}
        />
      </label>

      <label className="ma-settings-field">
        <span>{t('settings.privacy.interruptedPartsDays')}</span>
        <input
          type="number"
          min={0}
          value={settings?.interruptedPartsRetentionDays ?? 7}
          disabled={!isAdmin || !settings}
          onChange={(e) => void change('interruptedPartsRetentionDays', Math.max(0, Math.round(Number(e.target.value) || 0)))}
        />
      </label>

      {!isAdmin ? <p className="ma-settings-panel__hint">{t('settings.adminOnlyNote')}</p> : null}

      <div className="ma-settings-panel__danger">
        <h4>{t('settings.privacy.deleteAllTitle')}</h4>
        <p className="ma-settings-panel__hint">{t('settings.privacy.deleteAllWarning')}</p>
        <label className="ma-settings-field">
          <span>{t('settings.privacy.deleteAllConfirmLabel', { phrase: CONFIRM_PHRASE })}</span>
          <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </label>
        <button type="button" disabled={!confirmed || deleting} onClick={() => void deleteAllVoiceprints()}>
          {deleting ? t('settings.privacy.deleteAllRunning') : t('settings.privacy.deleteAllButton')}
        </button>
        {deleteResult ? <p className="ma-settings-panel__hint">{deleteResult}</p> : null}
      </div>

      {dataPolicy?.retention ? (
        <div className="ma-settings-panel__policy">
          <h4>{t('settings.privacy.dataPolicyTitle')}</h4>
          <p>{dataPolicy.retention}</p>
        </div>
      ) : null}

      {error ? (
        <p className="ma-settings-panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
