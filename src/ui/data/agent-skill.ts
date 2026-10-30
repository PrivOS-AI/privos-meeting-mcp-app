/**
 * The Room agent's Meeting skill (`agent-sets/privos-meeting`): lets the Room's
 * agent record a call the Room's shared browser joined (`meeting_listen_*`
 * through the Hub). Checked and installed from Settings → Room agent, as the
 * current user over `app.rest`, the flow PrivOS Remote Browser uses for its own
 * skill:
 *  - upload: `agents.sandbox.agentSets.preview` then `.confirm` (scope
 *    `sandbox:agent-sets:upload`, workspace admins), only when this exact
 *    version is not in the workspace's Agent Factory yet;
 *  - enable for the Room: `rooms.syncPrivOSSandboxSkills` (scope
 *    `sandbox:skills:use`), releasing older versions first.
 * The set's name carries a content hash (`scripts/package-agent-set.ts`), so a
 * changed skill is a new set the Sandbox extracts fresh.
 */
import type { McpApp } from '@privos_ai/app-react';

import { MEETING_AGENT_SET } from './agent-set-name.js';

const SKILL_PREFIX = 'privos-meeting';
const NOT_ALLOWED = /error-not-allowed|not allowed|forbidden|insufficient.?scope|not granted|permission|unauthori[sz]ed|\b40[13]\b/i;
const COLLOCATED = /collocation-agent-sets-disabled/i;

/** The scopes the two steps need: enabling a skill for the Room, and uploading it to Agent Factory. */
export const SKILL_USE_SCOPE = 'sandbox:skills:use';
export const SKILL_UPLOAD_SCOPE = 'sandbox:agent-sets:upload';

export type AgentSkillState = 'ready' | 'outdated' | 'not-enabled' | 'missing';
export type AgentSkillProblem = 'not-allowed' | 'collocated' | 'failed';

interface CatalogEntry {
  id: string;
  name: string;
  selected: boolean;
}

export class AgentSkillError extends Error {
  constructor(readonly problem: AgentSkillProblem, message: string) {
    super(message);
  }
}

function classify(error: unknown): AgentSkillError {
  const message = error instanceof Error ? error.message : String(error);
  if (COLLOCATED.test(message)) return new AgentSkillError('collocated', message);
  if (NOT_ALLOWED.test(message)) return new AgentSkillError('not-allowed', message);
  return new AgentSkillError('failed', message);
}

/** The JSON body under any `{ statusCode, body }` / `{ data }` wrapping the bridge or the route adds. */
function unwrap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (record.body && typeof record.body === 'object') return unwrap(record.body);
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) return unwrap(record.data);
  return record;
}

async function post(app: McpApp, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await app.rest({ method: 'POST', path, body });
  const status = (raw as { statusCode?: unknown } | null)?.statusCode;
  const value = unwrap(raw);
  // A refusal can come back as an answer rather than a throw: read it as the error it is.
  if (value.success === false || (typeof status === 'number' && status >= 400)) {
    const reason = typeof value.error === 'string' ? value.error : typeof value.message === 'string' ? value.message : `HTTP ${typeof status === 'number' ? status : '?'}`;
    throw new Error(`${path}: ${reason}`);
  }
  return value;
}

export function isMeetingAgentSet(name: string): boolean {
  return name === SKILL_PREFIX || name.startsWith(`${SKILL_PREFIX}-`);
}

/** The workspace Agent Factory's Meeting skill entries, with whether this Room has each enabled. */
async function catalog(app: McpApp, roomId: string): Promise<CatalogEntry[]> {
  const result = await post(app, 'rooms.listPrivOSSandboxSkills', { rid: roomId, useGlobal: true });
  const skills = Array.isArray(result.skills) ? (result.skills as Record<string, unknown>[]) : [];
  return skills
    .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && (s.type === undefined || s.type === 'agent_set'))
    .map((s) => ({ id: String(s.id), name: String(s.name), selected: s.selected === true || s.enabled === true || s.synced === true }))
    .filter((s) => isMeetingAgentSet(s.name));
}

/** Whether this Room's agent has the current Meeting skill. */
export async function checkAgentSkill(app: McpApp, roomId: string): Promise<AgentSkillState> {
  try {
    const entries = await catalog(app, roomId);
    const current = entries.find((e) => e.name === MEETING_AGENT_SET);
    if (current?.selected) return 'ready';
    if (entries.some((e) => e.selected)) return 'outdated';
    return current ? 'not-enabled' : 'missing';
  } catch (error) {
    throw classify(error);
  }
}

/** Uploads (when needed) and enables the bundled skill for this Room. `archiveDataUrl`: the inlined `privos-meeting.tar.gz`. */
export async function installAgentSkill(app: McpApp, roomId: string, archiveDataUrl: string): Promise<void> {
  try {
    let entries = await catalog(app, roomId);
    if (!entries.some((e) => e.name === MEETING_AGENT_SET)) {
      const base64 = /^data:[^,]*;base64,([A-Za-z0-9+/=]+)$/.exec(archiveDataUrl)?.[1];
      if (!base64) throw new AgentSkillError('failed', 'The bundled Meeting skill could not be read.');
      const preview = await post(app, 'agents.sandbox.agentSets.preview', { archives: [{ fileName: `${MEETING_AGENT_SET}.tar.gz`, base64 }] });
      const items = Array.isArray(preview.items) ? (preview.items as Array<{ name?: unknown }>) : [];
      if (typeof preview.sessionId !== 'string' || items.length !== 1 || items[0]?.name !== MEETING_AGENT_SET) {
        throw new AgentSkillError('failed', 'Agent Factory did not recognise exactly one Meeting skill; nothing was uploaded.');
      }
      await post(app, 'agents.sandbox.agentSets.confirm', { sessionId: preview.sessionId });
      entries = await catalog(app, roomId);
    }
    const stale = entries.filter((e) => e.name !== MEETING_AGENT_SET);
    const staleSelected = stale.filter((e) => e.selected).map((e) => e.id);
    if (staleSelected.length) await post(app, 'rooms.syncPrivOSSandboxSkills', { rid: roomId, removeAgentSetIds: staleSelected });
    // Housekeeping only: another Room may still use an old version, which the Hub then refuses to delete.
    for (const entry of stale) await post(app, 'agents.sandbox.agentSets.delete', { agentSetId: entry.id }).catch(() => undefined);
    const fresh = entries.find((e) => e.name === MEETING_AGENT_SET);
    if (!fresh) throw new AgentSkillError('failed', 'The Meeting skill was uploaded but is not in Agent Factory yet. Try again.');
    if (fresh.selected) return;
    const synced = await post(app, 'rooms.syncPrivOSSandboxSkills', { rid: roomId, addAgentSetIds: [fresh.id] });
    const failed = typeof synced.failed === 'number' ? synced.failed : 0;
    if (failed || (typeof synced.succeeded === 'number' && synced.succeeded < 1)) {
      throw new AgentSkillError('failed', `The Room's Sandbox did not take the skill (${failed} failed).`);
    }
  } catch (error) {
    throw error instanceof AgentSkillError ? error : classify(error);
  }
}
