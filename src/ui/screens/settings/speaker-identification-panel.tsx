/**
 * Settings › Speaker identification (plan.md § UI). Lists every workspace
 * profile from `speaker_profile_list`, with rename / link / delete / re-enrol
 * actions through `speaker_profile_update`/`_delete`, and a match-threshold
 * slider. The threshold slider calls `meeting_settings_set` — a tool this
 * phase does NOT build (out of P4's file ownership; owned by a later
 * settings phase per plan.md's tool table) — so saving it surfaces a clear
 * "not available yet" notice instead of pretending to persist silently. Once
 * that tool ships with the same name/shape, this panel starts working
 * without any further change.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { speakerProfileDelete, speakerProfileList, speakerProfileUpdate, type SpeakerProfileListItem } from '../../data/speaker-api.js';
import { SpeakerAvatar } from '../../components/speaker-avatar.js';
import { useI18n } from '../../i18n/i18n-provider.js';

const THRESHOLD_MIN = 0.3;
const THRESHOLD_MAX = 0.8;
const THRESHOLD_STEP = 0.01;
const DEFAULT_THRESHOLD = 0.5;

export function SpeakerIdentificationPanel() {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<SpeakerProfileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [thresholdNotice, setThresholdNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    speakerProfileList(app)
      .then((list) => {
        setProfiles(list);
        setRenameDrafts(Object.fromEntries(list.map((p) => [p.id, p.displayName])));
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [app]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function rename(profileId: string): Promise<void> {
    const displayName = (renameDrafts[profileId] ?? '').trim();
    if (!displayName) return;
    setBusyId(profileId);
    setRowError((prev) => ({ ...prev, [profileId]: '' }));
    try {
      await speakerProfileUpdate(app, { profileId, displayName });
      reload();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [profileId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  }

  async function reenrol(profileId: string): Promise<void> {
    setBusyId(profileId);
    setRowError((prev) => ({ ...prev, [profileId]: '' }));
    try {
      await speakerProfileUpdate(app, { profileId, action: 'reenrol' });
      reload();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [profileId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  }

  async function pruneOutliers(profileId: string): Promise<void> {
    if (!window.confirm(t('speaker.settingsPanel.pruneConfirm'))) return;
    setBusyId(profileId);
    setRowError((prev) => ({ ...prev, [profileId]: '' }));
    try {
      await speakerProfileUpdate(app, { profileId, action: 'pruneOutliers' });
      reload();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [profileId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(profileId: string): Promise<void> {
    if (!window.confirm(t('speaker.settingsPanel.deleteConfirm'))) return;
    setBusyId(profileId);
    setRowError((prev) => ({ ...prev, [profileId]: '' }));
    try {
      await speakerProfileDelete(app, profileId);
      reload();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [profileId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  }

  async function saveThreshold(): Promise<void> {
    setThresholdNotice(null);
    try {
      await app.callServerTool({ name: 'meeting_settings_set', arguments: { key: 'speakerMatchThreshold', value: threshold } });
      setThresholdNotice(t('speaker.settingsPanel.thresholdSaved'));
    } catch {
      setThresholdNotice(t('speaker.settingsPanel.thresholdUnavailable'));
    }
  }

  return (
    <section className="ma-speaker-settings">
      <h3 className="ma-speaker-settings__title">{t('speaker.settingsPanel.title')}</h3>

      <div className="ma-speaker-settings__threshold">
        <label htmlFor="ma-speaker-threshold">{t('speaker.settingsPanel.thresholdLabel', { value: threshold.toFixed(2) })}</label>
        <input
          id="ma-speaker-threshold"
          type="range"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={THRESHOLD_STEP}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
        <button type="button" onClick={() => void saveThreshold()}>
          {t('speaker.settingsPanel.thresholdSave')}
        </button>
        <p className="ma-speaker-settings__threshold-warning">{t('speaker.settingsPanel.thresholdWarning')}</p>
        {thresholdNotice ? <p className="ma-speaker-settings__threshold-notice">{thresholdNotice}</p> : null}
      </div>

      {loading ? <p>{t('speaker.settingsPanel.loading')}</p> : null}
      {loadError ? (
        <p className="ma-speaker-settings__error" role="alert">
          {loadError}
        </p>
      ) : null}

      {!loading && !loadError ? (
        <table className="ma-speaker-settings__table">
          <thead>
            <tr>
              <th>{t('speaker.settingsPanel.colName')}</th>
              <th>{t('speaker.settingsPanel.colSamples')}</th>
              <th>{t('speaker.settingsPanel.colMeetings')}</th>
              <th>{t('speaker.settingsPanel.colHealth')}</th>
              <th>{t('speaker.settingsPanel.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td className="ma-speaker-settings__name-cell">
                  <SpeakerAvatar name={p.displayName} colorKey={p.colorKey} size={24} />
                  <input
                    value={renameDrafts[p.id] ?? p.displayName}
                    maxLength={80}
                    onChange={(e) => setRenameDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                </td>
                <td>{p.sampleCount}</td>
                <td>{p.meetingCount}</td>
                <td>
                  {p.health ? (
                    <div className="ma-speaker-settings__health">
                      <span>{t('speaker.settingsPanel.healthMeanCosine', { value: p.health.meanPairwiseCosine.toFixed(2) })}</span>
                      <span className={p.health.outlierCount > 0 ? 'ma-speaker-settings__health-outliers' : 'ma-speaker-settings__health-none'}>
                        {t('speaker.settingsPanel.healthOutliers', { count: p.health.outlierCount })}
                      </span>
                    </div>
                  ) : (
                    <span className="ma-speaker-settings__health-none">{t('speaker.settingsPanel.healthUnavailable')}</span>
                  )}
                </td>
                <td className="ma-speaker-settings__actions-cell">
                  <button type="button" disabled={busyId === p.id} onClick={() => void rename(p.id)}>
                    {t('speaker.settingsPanel.actionRename')}
                  </button>
                  <button type="button" disabled={busyId === p.id} onClick={() => void reenrol(p.id)}>
                    {t('speaker.settingsPanel.actionReenrol')}
                  </button>
                  {p.health && p.health.outlierCount > 0 ? (
                    <button type="button" disabled={busyId === p.id} onClick={() => void pruneOutliers(p.id)}>
                      {t('speaker.settingsPanel.actionPrune')}
                    </button>
                  ) : null}
                  <button type="button" disabled={busyId === p.id} onClick={() => void remove(p.id)}>
                    {t('speaker.settingsPanel.actionDelete')}
                  </button>
                  {rowError[p.id] ? (
                    <span className="ma-speaker-settings__row-error" role="alert">
                      {rowError[p.id]}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {profiles.length === 0 ? (
              <tr>
                <td colSpan={5}>{t('speaker.settingsPanel.empty')}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
