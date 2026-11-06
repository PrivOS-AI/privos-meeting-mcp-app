import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { VerifiedActor } from '@privos_ai/app-server';

import publisherManifest from '../../../privos-app.json';
import { AppError } from '../../shared/app-error.js';
import { CallerRefusedError, SHARED_TOOLS, applyCallerPolicy } from './caller-policy.js';

const person: VerifiedActor = { userId: 'u1', roomId: 'r1', claims: {}, provenance: 'user-token' };
const agent: VerifiedActor = { ...person, userId: 'bot1', principalType: 'bot' };
const otherApp: VerifiedActor = { ...agent, callerApp: 'ai.privos.vibe-flow' };
const none = new Set<string>();

function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return undefined;
}

describe('caller policy', () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('leaves a person calling any tool as it was, room argument included', () => {
    const args = { roomId: 'other-room', meetingId: 'm1' };
    expect(applyCallerPolicy('meeting_settings_set', person, args, none)).toBe(args);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets an agent call a shared tool, in the signed room only', () => {
    expect(applyCallerPolicy('meeting_listen_status', agent, { meetingId: 'm1' }, none)).toEqual({ meetingId: 'm1', roomId: 'r1' });
    expect(applyCallerPolicy('meeting_listen_status', agent, { roomId: 'r1', meetingId: 'm1' }, none)).toEqual({ roomId: 'r1', meetingId: 'm1' });
    expect(refusal(() => applyCallerPolicy('meeting_listen_status', agent, { roomId: 'r2', meetingId: 'm1' }, none))).toBe('ROOM_MISMATCH');
    expect(refusal(() => applyCallerPolicy('meeting_listen_status', { ...agent, roomId: undefined }, { roomId: 'r1' }, none))).toBe('ROOM_MISMATCH');
  });

  it('refuses an agent every tool that is not shared', () => {
    for (const tool of ['meeting_agent_bot_credential_check', 'meeting_realtime_token', 'meeting_audio_push', 'meeting_forget_voiceprints', 'speaker_profile_delete', 'speaker_profile_list', 'meeting_settings_set']) {
      expect(refusal(() => applyCallerPolicy(tool, agent, { roomId: 'r1' }, none)), tool).toBe('CALLER_NOT_ALLOWED');
    }
  });

  it("refuses another app's server unless it is allowed, and always from outside the room", () => {
    expect(refusal(() => applyCallerPolicy('meeting_status', otherApp, { roomId: 'r1' }, none))).toBe('CALLER_NOT_ALLOWED');
    const allowed = new Set(['ai.privos.vibe-flow']);
    expect(applyCallerPolicy('meeting_status', otherApp, { roomId: 'r1' }, allowed)).toEqual({ roomId: 'r1' });
    expect(refusal(() => applyCallerPolicy('meeting_status', { ...otherApp, crossRoom: true }, { roomId: 'r1' }, allowed))).toBe('CROSS_ROOM_NOT_ALLOWED');
    expect(refusal(() => applyCallerPolicy('meeting_settings_set', otherApp, { roomId: 'r1' }, allowed))).toBe('CALLER_NOT_ALLOWED');
    // App Cluster dispatch carries no principal type: the caller app alone marks it as automation.
    expect(refusal(() => applyCallerPolicy('meeting_settings_set', { ...person, callerApp: 'ai.privos.vibe-flow' }, { roomId: 'r1' }, allowed))).toBe('CALLER_NOT_ALLOWED');
  });

  it('logs each refusal once with its code, room, caller app, principal type and tool — never an argument', () => {
    expect(() => applyCallerPolicy('meeting_settings_set', agent, { roomId: 'r1', secret: 'do-not-log' }, none)).toThrow(CallerRefusedError);
    expect(() => applyCallerPolicy('meeting_status', { ...otherApp, crossRoom: true }, { roomId: 'r1' }, new Set(['ai.privos.vibe-flow']))).toThrow(CallerRefusedError);
    expect(() => applyCallerPolicy('meeting_status', agent, { roomId: 'r2' }, none)).toThrow(CallerRefusedError);
    expect(warn.mock.calls.map((call) => call.join(' '))).toEqual([
      '[caller-policy] refused CALLER_NOT_ALLOWED room=r1 callerApp=- ptype=bot tool=meeting_settings_set',
      '[caller-policy] refused CROSS_ROOM_NOT_ALLOWED room=r1 callerApp=ai.privos.vibe-flow ptype=bot tool=meeting_status',
      '[caller-policy] refused ROOM_MISMATCH room=r1 callerApp=- ptype=bot tool=meeting_status',
    ]);
  });

  it('shares only the recording and question tools, never the UI tool', () => {
    expect([...SHARED_TOOLS].sort()).toEqual(['meeting_ask', 'meeting_listen_start', 'meeting_listen_status', 'meeting_listen_stop', 'meeting_status']);
    const names = new Set(publisherManifest.tools.map((tool) => tool.name));
    for (const name of SHARED_TOOLS) expect(names.has(name), name).toBe(true);
    expect(SHARED_TOOLS.has(publisherManifest.tools[0].name)).toBe(false);
  });
});
