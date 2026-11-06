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
import { AgentSkillError, checkAgentSkill, installAgentSkill, SKILL_UPLOAD_SCOPE, SKILL_USE_SCOPE, type AgentSkillProblem, type AgentSkillState } from '../../data/agent-skill.js';
import { useI18n } from '../../i18n/i18n-provider.js';

export function RoomAgentPanel() {
  const app = usePrivosApp();
  const { roomId, effectiveScopes } = usePrivosContext();
  const { t } = useI18n();
  const [state, setState] = useState<AgentSkillState | null>(null);
  const [problem, setProblem] = useState<{ kind: AgentSkillProblem; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Granted scopes, when the host reports them (UX only: the Hub decides). The skill steps
  // need optional scopes an admin approves separately from refreshing the app.
  const missingScopes = effectiveScopes ? [SKILL_USE_SCOPE, SKILL_UPLOAD_SCOPE].filter((scope) => !effectiveScopes.includes(scope)) : [];
  const canUse = !missingScopes.includes(SKILL_USE_SCOPE);

  const fail = (error: unknown) => {
    console.error('[room-agent] skill step failed:', error);
    const detail = error instanceof Error ? error.message : String(error);
    setProblem({ kind: error instanceof AgentSkillError ? error.problem : 'failed', detail: detail.slice(0, 300) });
  };

  const refresh = useCallback(() => {
    if (!roomId || !canUse) return;
    checkAgentSkill(app, roomId)
      .then((next) => {
        setState(next);
        setProblem(null);
      })
      .catch(fail);
  }, [app, roomId, canUse]);
  useEffect(refresh, [refresh]);

  async function install(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await installAgentSkill(app, roomId, meetingSkillArchive);
      setState('ready');
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.agent.title')}</h3>
      <p className="ma-settings-panel__hint">{t('settings.agent.intro')}</p>

      {missingScopes.length > 0 ? (
        <div className="ma-notice ma-notice--warning" role="status">
          <span>
            {t('settings.agent.scopesMissing', { scopes: missingScopes.join(', ') })}
          </span>
        </div>
      ) : null}

      {canUse ? <p role="status">{state ? t(`settings.agent.state.${state}`) : problem ? null : t('settings.agent.checking')}</p> : null}
      {canUse && (state === null ? problem !== null : state !== 'ready') ? (
        <button type="button" disabled={busy} onClick={() => void (state === null ? refresh() : install())}>
          {busy ? t('settings.agent.installing') : state === null ? t('settings.agent.retry') : t(state === 'outdated' ? 'settings.agent.update' : 'settings.agent.install')}
        </button>
      ) : null}
      {problem ? (
        <div className="ma-settings-panel__error" role="alert">
          <p>{t(`settings.agent.problem.${problem.kind}`)}</p>
          {/* The Hub's own words: what an admin needs to fix it. */}
          <code className="ma-settings-panel__error-detail">{problem.detail}</code>
        </div>
      ) : null}

      <div className="ma-settings-panel__policy">
        <h4>{t('settings.agent.exampleTitle')}</h4>
        <pre className="ma-settings-panel__example">{t('settings.agent.exampleStart')}</pre>
        <pre className="ma-settings-panel__example">{t('settings.agent.exampleStop')}</pre>
      </div>
    </section>
  );
}
