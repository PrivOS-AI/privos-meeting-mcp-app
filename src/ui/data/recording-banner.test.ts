import { describe, expect, it } from 'vitest';

import type { ActiveRecordingMeeting } from './meeting-draft-repository.js';
import { ENDED_NOTICE_MS, pickRecordingBanner } from './recording-banner.js';

const NOW = Date.parse('2026-11-06T10:00:00Z');
const agentRecording: ActiveRecordingMeeting = { _id: 'b1', status: 'recording', captureSource: 'browser', ownerUserId: 'agent-bot', startedAt: '2026-11-06T09:00:00Z' };
const myStuckMic: ActiveRecordingMeeting = { _id: 'm1', status: 'interrupted', partCount: 3, ownerUserId: 'me' };
const pick = (over: Partial<Parameters<typeof pickRecordingBanner>[0]> = {}) =>
  pickRecordingBanner({ own: [], roomBrowser: [], userId: 'me', dismissed: new Set(), now: NOW, ...over });

describe('recording banner', () => {
  it("shows a Room-browser recording the agent started to everyone in the room, not as the viewer's", () => {
    expect(pick({ roomBrowser: [agentRecording] })).toEqual({ kind: 'browser-live', meeting: agentRecording, isOwner: false });
    expect(pick({ roomBrowser: [{ ...agentRecording, ownerUserId: 'me' }] })).toMatchObject({ kind: 'browser-live', isOwner: true });
  });

  it('puts a running Room-browser recording before the viewer’s own unfinished one, and skips the one this tab shows', () => {
    expect(pick({ own: [myStuckMic], roomBrowser: [agentRecording] })).toMatchObject({ kind: 'browser-live' });
    expect(pick({ own: [myStuckMic], roomBrowser: [agentRecording], showingMeetingId: 'b1' })).toEqual({ kind: 'recover', meeting: myStuckMic });
  });

  it('announces a recording that stopped by itself for an hour, until dismissed', () => {
    const ended: ActiveRecordingMeeting = { _id: 'b2', status: 'failed', captureSource: 'browser', ownerUserId: 'agent-bot', captureEndReason: 'unreachable', endedAt: new Date(NOW - 5 * 60_000).toISOString() };
    expect(pick({ roomBrowser: [ended] })).toEqual({ kind: 'browser-ended', meeting: ended });
    expect(pick({ roomBrowser: [ended], dismissed: new Set(['b2']) })).toBeNull();
    expect(pick({ roomBrowser: [{ ...ended, endedAt: new Date(NOW - ENDED_NOTICE_MS - 1).toISOString() }] })).toBeNull();
    // Stopped by a person (no reason kept): nothing to announce.
    expect(pick({ roomBrowser: [{ ...ended, captureEndReason: undefined, status: 'summarized' }] })).toBeNull();
  });

  it("offers to recover the viewer's own unfinished recording, but never a live Room-browser one", () => {
    expect(pick({ own: [myStuckMic] })).toEqual({ kind: 'recover', meeting: myStuckMic });
    expect(pick({ own: [{ ...agentRecording, ownerUserId: 'me' }] })).toBeNull();
    expect(pick({ own: [{ ...agentRecording, ownerUserId: 'me', status: 'interrupted' }] })).toMatchObject({ kind: 'recover' });
  });
});
