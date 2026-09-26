import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';
import { sessionRegistries } from '../speaker/session-speaker-registry.js';
import type { ToolRuntime } from './registry.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

function context(userId: string): ToolCallContext {
  return {
    transport: 'direct',
    identityState: 'verified',
    sessionScope: 'test',
    actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' },
  };
}

/** A runtime whose `agentBotHub` is the SAME fake hub the DB client talks to — needed by any test that exercises the retained-turns Files hydration path; every other test passes `{} as never`, which structurally skips hydration (hub undefined). */
function runtimeWithHub(): ToolRuntime {
  return { agentBotHub: fakeHub };
}

const { liveSpeakersTool } = await import('./live-speakers-tool.js');

function seg(speaker: string, startMs: number, endMs = startMs + 1000) {
  return { speaker, startMs, endMs, final: true };
}

describe('meeting_live_speakers', () => {
  beforeEach(() => {
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', status: 'recording' }],
      meeting_speakers: [
        {
          _id: 'ms-1',
          meeting: 'meeting-1',
          sessionSpeakerId: 'ss-1',
          sonioxLabels: ['s0:1'],
          displayName: 'An',
          profileId: 'profile-1',
          liveConfidence: 0.8,
          liveSpeechSec: 12,
          colorKey: 'blue',
          resolved: true,
          pendingEmbedding: JSON.stringify({ ct: 'secret-ciphertext', iv: 'x', tag: 'y', hmac: 'z', profileId: 'live:m:ss-1', createdAt: 'now' }),
        },
      ],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
    // Every test gets its own registry: this file reuses meetingId "meeting-1"
    // across tests, and `sessionRegistries` is a process-wide singleton that
    // would otherwise leak turns/speakers from one test into the next.
    sessionRegistries.delete('meeting-1');
  });

  it('any room member (not just the owner) can read live speakers', async () => {
    const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
      sessionSpeakers: Array<Record<string, unknown>>;
      labelsSupported: boolean;
    };
    expect(raw.labelsSupported).toBe(true);
    expect(raw.sessionSpeakers).toHaveLength(1);
    expect(raw.sessionSpeakers[0]).toMatchObject({ sessionSpeakerId: 'ss-1', displayName: 'An', profileId: 'profile-1', resolved: true });
  });

  it('never leaks pendingEmbedding or any vector-shaped field', async () => {
    const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
      sessionSpeakers: Array<Record<string, unknown>>;
    };
    const json = JSON.stringify(raw);
    expect(json).not.toMatch(/pendingEmbedding/);
    expect(json).not.toMatch(/secret-ciphertext/);
  });

  it('returns labelsSupported:false and an empty list for a degraded (ElevenLabs) meeting', async () => {
    store.app_settings.push({ _id: 'row-1', key: 'room:room-1:sttRealtimeProvider', valueJson: JSON.stringify('elevenlabs') });
    const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
      sessionSpeakers: unknown[];
      labelsSupported: boolean;
    };
    expect(raw.labelsSupported).toBe(false);
    expect(raw.sessionSpeakers).toEqual([]);
  });

  it('rejects a caller outside the room', async () => {
    await expect(
      liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, { ...context('user-2'), actor: { userId: 'user-2', roomId: 'room-2', claims: {}, provenance: 'user-token' } }, {} as never),
    ).rejects.toThrow();
  });

  describe('turns', () => {
    it('returns settled turns with no sinceMs, capped to a nextSinceMs cursor for the next poll', async () => {
      const registry = sessionRegistries.get('meeting-1');
      registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 1, seg('s0:1', 0));
      registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 1, seg('s0:1', 1000));

      const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
        turns: Array<{ startMs: number; endMs: number; label: string; sessionSpeakerId: string }>;
        nextSinceMs: number;
      };
      expect(raw.turns).toHaveLength(2);
      expect(raw.turns[0]).toMatchObject({ startMs: 0, endMs: 1000, label: 's0:1' });
      expect(raw.turns[1]).toMatchObject({ startMs: 1000, endMs: 2000, label: 's0:1' });
      expect(raw.nextSinceMs).toBe(1000); // the last returned turn's own startMs
    });

    it('turns and sessionSpeakers both stay vector- and text-free', async () => {
      const registry = sessionRegistries.get('meeting-1');
      registry.observe('s0:2', new Float32Array([0, 1, 0, 0]), 3, seg('s0:2', 5000));
      const raw = await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never);
      const json = JSON.stringify(raw);
      expect(json).not.toMatch(/pendingEmbedding/);
      expect(json).not.toMatch(/secret-ciphertext/);
      // A turn is only ever {startMs,endMs,label,sessionSpeakerId} — no free-form text field exists to leak.
      const parsed = raw as { turns: Array<Record<string, unknown>> };
      for (const turn of parsed.turns) {
        expect(Object.keys(turn).sort()).toEqual(['endMs', 'label', 'sessionSpeakerId', 'startMs']);
      }
    });

    it('rejects a negative sinceMs without silently clamping it', async () => {
      await expect(
        liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', sinceMs: -1 }, context('user-2'), {} as never),
      ).rejects.toThrow(/sinceMs/);
    });

    it('rejects a non-finite sinceMs', async () => {
      await expect(
        liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', sinceMs: Number.NaN }, context('user-2'), {} as never),
      ).rejects.toThrow(/sinceMs/);
    });

    it('only returns turns strictly newer than sinceMs', async () => {
      const registry = sessionRegistries.get('meeting-1');
      registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 1, seg('s0:1', 0));
      registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 1, seg('s0:1', 1000));
      registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 1, seg('s0:1', 2000));

      const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', sinceMs: 1000 }, context('user-2'), {} as never)) as {
        turns: Array<{ startMs: number }>;
      };
      expect(raw.turns.map((t) => t.startMs)).toEqual([2000]);
    });

    it('hard-caps a large backlog at 500 turns per response and pages via nextSinceMs', async () => {
      const registry = sessionRegistries.get('meeting-1');
      for (let i = 0; i < 550; i++) {
        registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 1, seg('s0:1', (i + 1) * 1000));
      }

      const page1 = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', sinceMs: 0 }, context('user-2'), {} as never)) as {
        turns: Array<{ startMs: number }>;
        nextSinceMs: number;
      };
      expect(page1.turns).toHaveLength(500);
      expect(page1.turns[0].startMs).toBe(1000);
      expect(page1.turns[499].startMs).toBe(500_000);
      expect(page1.nextSinceMs).toBe(500_000);

      const page2 = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', sinceMs: page1.nextSinceMs }, context('user-2'), {} as never)) as {
        turns: Array<{ startMs: number }>;
      };
      expect(page2.turns).toHaveLength(50);
      expect(page2.turns[0].startMs).toBe(501_000);
      expect(page2.turns[49].startMs).toBe(550_000);
    });

    it('reports a merge loser\'s turns under the winner id, including turns recorded before the merge happened', async () => {
      const registry = sessionRegistries.get('meeting-1');
      registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 20, seg('s0:1', 0)); // A: speechSec=20 (will win by speech)
      registry.observe('s1:2', new Float32Array([0, 1, 0, 0]), 5, seg('s1:2', 30_000)); // B: distinct, brand new
      registry.observe('s1:2', new Float32Array([0.6, 0.8, 0, 0]), 5, seg('s1:2', 36_000)); // converges toward A
      registry.observe('s1:2', new Float32Array([1, 0, 0, 0]), 5, seg('s1:2', 42_000)); // merges in-memory

      const winnerId = registry.snapshot().find((s) => !s.mergedInto)!.sessionSpeakerId;
      const loserId = registry.snapshot().find((s) => s.mergedInto)!.sessionSpeakerId;
      expect(winnerId).not.toBe(loserId);

      const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
        turns: Array<{ sessionSpeakerId: string }>;
      };
      expect(raw.turns).toHaveLength(4);
      expect(raw.turns.map((t) => t.sessionSpeakerId)).toEqual([winnerId, winnerId, winnerId, winnerId]);
      expect(raw.turns.some((t) => t.sessionSpeakerId === loserId)).toBe(false);
    });

    it('hydrates the retained-turns buffer from live-turns.json ONCE per meeting/process, never re-reading Files on a later poll', async () => {
      store.meetings[0].folderId = 'folder-1';
      const filesChannelPath = `/api/v1/file-management.files.channel/${encodeURIComponent('room-1')}?folderId=${encodeURIComponent('folder-1')}&count=100`;
      const filesCalls: string[] = [];
      fakeHub = installFakeHub({
        store,
        handlers: {
          [filesChannelPath]: () => {
            filesCalls.push(filesChannelPath);
            return { success: true, files: [] }; // no live-turns.json yet — a normal "nothing to hydrate" outcome
          },
        },
      });

      await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), runtimeWithHub());
      await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), runtimeWithHub());
      await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), runtimeWithHub());

      expect(filesCalls).toHaveLength(1); // hydrated on the very first poll only
    });
  });
});
