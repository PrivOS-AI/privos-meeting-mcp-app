import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MEETING_AGENT_SET } from './agent-set-name.js';
import { AgentSkillError, checkAgentSkill, installAgentSkill } from './agent-skill.js';
// @ts-expect-error — plain .mjs run in the Room's Sandbox, imported here for its helpers.
import { ALLOWED_TOOLS, pickMeetingApp, toolResult } from '../../../agent-sets/privos-meeting/skills/privos-meeting/scripts/meeting-tool.mjs';

const skillDir = path.resolve('agent-sets/privos-meeting/skills/privos-meeting');

describe('the packaged Meeting skill', () => {
  it('is packaged from the current SKILL.md and script (run `npm run package:agent-set` after editing them)', () => {
    const hash = createHash('sha256');
    for (const file of ['SKILL.md', 'scripts/meeting-tool.mjs']) hash.update(readFileSync(path.join(skillDir, file), 'utf8').replace(/\r\n/g, '\n')).update('\0');
    expect(MEETING_AGENT_SET).toBe(`privos-meeting-${hash.digest('hex').slice(0, 8)}`);
    const listing = execFileSync('tar', ['-tzf', 'privos-meeting.tar.gz'], { cwd: path.resolve('agent-sets'), encoding: 'utf8' });
    expect(listing).toContain(`${MEETING_AGENT_SET}/skills/privos-meeting/SKILL.md`);
    expect(listing).toContain(`${MEETING_AGENT_SET}/skills/privos-meeting/scripts/meeting-tool.mjs`);
  });

  it('the script calls only the recording and question tools, and finds the one Meeting app of the Room', () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual(['meeting_ask', 'meeting_listen_start', 'meeting_listen_status', 'meeting_listen_stop', 'meeting_status']);
    expect(pickMeetingApp([{ status: 'ACTIVE', appId: 'ai.privos.meeting-agent', mcpAppId: 'm1' }, { status: 'ACTIVE', appId: 'ai.privos.remote-browser', mcpAppId: 'r1' }])).toEqual({ appId: 'm1' });
    expect(pickMeetingApp([]).error).toMatch(/no PrivOS Meeting app/);
  });

  it("the script turns the app's answer into data, and its error into a message with the code", () => {
    expect(toolResult({ success: true, result: { structuredContent: { meetingId: 'x', state: 'listening' } } })).toEqual({ meetingId: 'x', state: 'listening' });
    expect(toolResult({ success: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })).toEqual({ ok: true });
    expect(() => toolResult({ success: true, result: { isError: true, structuredContent: { error: { code: 'NOT_MEETING_OWNER', message: 'Only the meeting owner can perform this action.' } } } })).toThrow(
      'Only the meeting owner can perform this action. [NOT_MEETING_OWNER]',
    );
  });
});

/** An `app.rest` that records calls and answers from `routes`. */
function fakeApp(routes: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const app = {
    rest: async ({ path: p, body }: { path: string; body: Record<string, unknown> }) => {
      calls.push({ path: p, body });
      const route = routes[p];
      if (!route) throw new Error(`unexpected ${p}`);
      return { success: true, ...(route(body) as object) };
    },
  };
  return { app: app as never, calls };
}

describe('installing the skill for the Room agent', () => {
  const archive = `data:application/gzip;base64,${Buffer.from('tar').toString('base64')}`;

  it('reports what the Room has', async () => {
    const skills = (list: unknown[]) => fakeApp({ 'rooms.listPrivOSSandboxSkills': () => ({ skills: list }) }).app;
    await expect(checkAgentSkill(skills([{ id: 'a', name: MEETING_AGENT_SET, type: 'agent_set', selected: true }]), 'room-1')).resolves.toBe('ready');
    await expect(checkAgentSkill(skills([{ id: 'o', name: 'privos-meeting-00000000', type: 'agent_set', selected: true }]), 'room-1')).resolves.toBe('outdated');
    await expect(checkAgentSkill(skills([{ id: 'a', name: MEETING_AGENT_SET, type: 'agent_set' }]), 'room-1')).resolves.toBe('not-enabled');
    await expect(checkAgentSkill(skills([{ id: 'r', name: 'privos-remote-browser-1', type: 'agent_set', selected: true }]), 'room-1')).resolves.toBe('missing');
  });

  it('uploads a new version, releases the old one and enables the new one for the Room', async () => {
    let catalog = [{ id: 'old', name: 'privos-meeting-00000000', type: 'agent_set', selected: true }];
    const { app, calls } = fakeApp({
      'rooms.listPrivOSSandboxSkills': () => ({ skills: catalog }),
      'agents.sandbox.agentSets.preview': () => ({ sessionId: 's1', items: [{ name: MEETING_AGENT_SET }] }),
      'agents.sandbox.agentSets.confirm': () => {
        catalog = [...catalog, { id: 'new', name: MEETING_AGENT_SET, type: 'agent_set', selected: false }];
        return {};
      },
      'agents.sandbox.agentSets.delete': () => ({}),
      'rooms.syncPrivOSSandboxSkills': () => ({ succeeded: 1, failed: 0 }),
    });
    await installAgentSkill(app, 'room-1', archive);
    expect(calls.map((c) => c.path)).toEqual([
      'rooms.listPrivOSSandboxSkills',
      'agents.sandbox.agentSets.preview',
      'agents.sandbox.agentSets.confirm',
      'rooms.listPrivOSSandboxSkills',
      'rooms.syncPrivOSSandboxSkills',
      'agents.sandbox.agentSets.delete',
      'rooms.syncPrivOSSandboxSkills',
    ]);
    expect(calls[4].body).toEqual({ rid: 'room-1', removeAgentSetIds: ['old'] });
    expect(calls.at(-1)!.body).toEqual({ rid: 'room-1', addAgentSetIds: ['new'] });
  });

  it('says when PrivOS refuses (not an admin) or the Sandbox cannot load skills', async () => {
    const refuse = (message: string) => fakeApp({ 'rooms.listPrivOSSandboxSkills': () => { throw new Error(message); } }).app;
    await expect(installAgentSkill(refuse('Not allowed [error-not-allowed]'), 'room-1', archive)).rejects.toMatchObject({ problem: 'not-allowed' });
    await expect(installAgentSkill(refuse('collocation-agent-sets-disabled'), 'room-1', archive)).rejects.toBeInstanceOf(AgentSkillError);
  });
});
