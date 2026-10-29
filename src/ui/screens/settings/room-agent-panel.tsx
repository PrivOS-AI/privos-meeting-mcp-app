/**
 * Settings › Room agent: lets the Room's agent record a Google Meet call that
 * the Room's shared browser (PrivOS Remote Browser) joined, by installing the
 * app's Meeting skill into the Room's Sandbox (`data/agent-skill.ts`). Shows
 * whether this Room's agent has the current skill; uploading a new version
 * needs a workspace admin, enabling it for the Room a Room owner.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import meetingSkillArchive from '../../../../agent-sets/privos-meeting.tar.gz?url&inline';
import { AgentSkillError, checkAgentSkill, installAgentSkill, type AgentSkillProblem, type AgentSkillState } from '../../data/agent-skill.js';
import { useI18n } from '../../i18n/i18n-provider.js';

export function RoomAgentPanel() {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t } = useI18n();
  const [state, setState] = useState<AgentSkillState | null>(null);
  const [problem, setProblem] = useState<AgentSkillProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!roomId) return;
    checkAgentSkill(app, roomId)
      .then((next) => {
        setState(next);
        setProblem(null);
      })
      .catch((error: unknown) => setProblem(error instanceof AgentSkillError ? error.problem : 'failed'));
  }, [app, roomId]);
  useEffect(refresh, [refresh]);

  async function install(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await installAgentSkill(app, roomId, meetingSkillArchive);
      setState('ready');
    } catch (error) {
      setProblem(error instanceof AgentSkillError ? error.problem : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.agent.title')}</h3>
      <p className="ma-settings-panel__hint">{t('settings.agent.intro')}</p>

      <p role="status">{state ? t(`settings.agent.state.${state}`) : t('settings.agent.checking')}</p>
      {state && state !== 'ready' ? (
        <button type="button" disabled={busy} onClick={() => void install()}>
          {busy ? t('settings.agent.installing') : t(state === 'outdated' ? 'settings.agent.update' : 'settings.agent.install')}
        </button>
      ) : null}
      {problem ? (
        <p className="ma-settings-panel__error" role="alert">
          {t(`settings.agent.problem.${problem}`)}
        </p>
      ) : null}

      <div className="ma-settings-panel__policy">
        <h4>{t('settings.agent.exampleTitle')}</h4>
        <pre className="ma-settings-panel__example">{t('settings.agent.exampleStart')}</pre>
        <pre className="ma-settings-panel__example">{t('settings.agent.exampleStop')}</pre>
      </div>
    </section>
  );
}
