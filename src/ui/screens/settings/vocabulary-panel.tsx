/**
 * Settings › Speech recognition › Vocabulary: the Room's own names and terms
 * (products, projects, customers) that the built-in recognition should prefer
 * over a similar-sounding common word (`server/asr/hotwords.ts`). One
 * `app_settings` key, `vocabulary`, written by the room's owners and
 * moderators; people the app knows by voice are added on the server, so they
 * need not be typed here.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { loadWorkspaceSettings, saveWorkspaceSetting } from '../../data/settings-store.js';
import { parseVocabulary, VOCABULARY_MAX_CHARS, VOCABULARY_MAX_TERMS } from '../../../shared/app-settings.js';
import { useCanManageRoomSettings } from './use-can-manage-room-settings.js';

export function VocabularyPanel() {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t } = useI18n();
  const { canManage } = useCanManageRoomSettings();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    loadWorkspaceSettings(app, roomId)
      .then((settings) => {
        setSaved(settings.vocabulary);
        setDraft(settings.vocabulary);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [app, roomId]);

  const terms = parseVocabulary(draft);
  const tooMany = terms.length > VOCABULARY_MAX_TERMS;

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const value = terms.join('\n');
      await saveWorkspaceSetting(app, 'vocabulary', value);
      setSaved(value);
      setDraft(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ma-settings-panel">
      <h4 className="ma-settings-panel__subtitle">{t('settings.vocabulary.title')}</h4>
      <p className="ma-settings-panel__hint">{t('settings.vocabulary.intro')}</p>
      <label className="ma-settings-field ma-settings-field--wide">
        <span>{t('settings.vocabulary.label')}</span>
        <textarea
          rows={6}
          value={draft}
          maxLength={VOCABULARY_MAX_CHARS}
          placeholder={t('settings.vocabulary.placeholder')}
          disabled={!canManage || saved === null || saving}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <p className={tooMany ? 'ma-settings-panel__warning' : 'ma-settings-panel__hint'}>
        {t('settings.vocabulary.count', { count: terms.length, max: VOCABULARY_MAX_TERMS })}
      </p>
      {canManage ? (
        <div className="ma-settings-panel__actions">
          <button type="button" disabled={saved === null || saving || tooMany || draft === saved} onClick={() => void save()}>
            {saving ? t('settings.vocabulary.saving') : t('settings.vocabulary.save')}
          </button>
        </div>
      ) : (
        <p className="ma-settings-panel__hint">{t('settings.adminOnlyNote')}</p>
      )}
      <p className="ma-settings-panel__hint">{t('settings.vocabulary.localOnly')}</p>
      {error ? (
        <p className="ma-settings-panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
