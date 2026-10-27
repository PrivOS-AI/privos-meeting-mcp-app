/**
 * Live speakers for the built-in recognizer. The provider has no speaker
 * labels, but every finished utterance arrives here with its own audio: it is
 * embedded once and folded into the meeting's session-speaker registry — the
 * same registry, profile matching, `meeting_speakers` rows and
 * `live-turns.json` the chunk worker maintains for a labelling provider. Each
 * utterance gets its own one-off label (`local:<index>`), so the registry
 * decides by voice alone: the closest session speaker above the assign bar, or
 * a new one.
 *
 * The attribution itself is in memory and returns with the caption; what
 * touches the Hub (profile naming, row upserts, `live-turns.json`) is batched
 * every few seconds on the meeting's serial queue, never on the caption path,
 * and never interleaved with `speaker_resolve`.
 *
 * Off when the room turned `speakerRecognition` off: no embedding is computed.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import type { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { appendLiveTurns, type LiveTurnSpan } from '../media/live-turns-store.js';
import { computeEmbedding } from '../speaker/embedding-extractor.js';
import { isSpeakerRecognitionEnabled } from '../speaker/resolve-speakers.js';
import { append, flush } from '../speaker/speaker-diagnostics-log.js';
import { matchPendingAgainstProfiles, runOnMeetingQueue, toDiagnosticEvent } from './chunk-worker.js';
import { ensureRegistry, upsertAll } from './live-speaker-repository.js';

const SAMPLE_RATE = 16000;
/** Below this an utterance's embedding is too noisy to decide a speaker by (CAM++ needs ~1 s of speech). */
const MIN_EMBED_SEC = 1;
/** A too-short utterance this close after the previous one is taken to be the same person still talking. */
const CONTINUATION_GAP_SEC = 1.5;
/** How often the Hub side (naming, rows, live-turns.json) catches up. */
const PERSIST_EVERY_MS = 3000;

export interface FinishedUtterance {
  index: number;
  samples: Float32Array;
  atSec: number;
  endSec: number;
}

/** Returns the session speaker an utterance belongs to, or `undefined` when it cannot tell. */
export interface UtteranceAttributor {
  (utterance: FinishedUtterance): Promise<string | undefined>;
  /** Writes what is still pending (naming, rows, live-turns.json) now; resolves when it is done. */
  flush(): Promise<void>;
}

export interface LocalAttributionContext {
  db: AppDbBotClient;
  hub: RoomBoundHubClient;
  roomId: string;
  folderId: string;
  meetingId: string;
}

export function createLocalSpeakerAttributor(ctx: LocalAttributionContext): UtteranceAttributor {
  const enabled = isSpeakerRecognitionEnabled(ctx.db).catch(() => false);
  let last: { speakerId: string; endSec: number } | null = null;
  let persistTimer: NodeJS.Timeout | null = null;

  const persist = (): Promise<void> => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    return runOnMeetingQueue(ctx.meetingId, async (signal) => {
      const registry = await ensureRegistry(ctx.db, ctx.meetingId, ctx.hub, ctx.roomId, ctx.folderId);
      await matchPendingAgainstProfiles(ctx.db, registry);
      const settled = registry.settledTurns();
      if (settled.length > 0) {
        const spans: LiveTurnSpan[] = settled.map((t) => ({
          id: `${t.sessionSpeakerId}:${t.startMs}`,
          speakerKey: t.sessionSpeakerId,
          startMs: t.startMs,
          endMs: t.endMs,
          text: '',
          sessionIndex: 0,
        }));
        await appendLiveTurns(ctx.hub, ctx.roomId, ctx.folderId, spans, signal);
      }
      await upsertAll(ctx.db, ctx.meetingId, registry);
      await flush(registry);
    }).catch((error: unknown) => {
      console.warn('[local-attribution] persisting live speakers failed (retried with the next utterance):', ctx.meetingId, error instanceof Error ? error.message : error);
    });
  };
  const schedulePersist = () => {
    persistTimer ??= setTimeout(() => void persist(), PERSIST_EVERY_MS);
  };

  const attribute = async ({ index, samples, atSec, endSec }: FinishedUtterance): Promise<string | undefined> => {
    if (!(await enabled)) return undefined;
    const durSec = samples.length / SAMPLE_RATE;
    if (durSec < MIN_EMBED_SEC) {
      if (!last || atSec - last.endSec > CONTINUATION_GAP_SEC) return undefined;
      last.endSec = endSec;
      return last.speakerId;
    }

    let embedding: Float32Array;
    try {
      embedding = await computeEmbedding(samples);
    } catch {
      return undefined;
    }
    const registry = await ensureRegistry(ctx.db, ctx.meetingId, ctx.hub, ctx.roomId, ctx.folderId);
    const label = `local:${index}`;
    const seg = { speaker: label, startMs: Math.round(atSec * 1000), endMs: Math.round(endSec * 1000), final: true };
    registry.observe(label, embedding, durSec, seg, (fact) => append(registry, toDiagnosticEvent(ctx.meetingId, index, fact)));

    // A one-off label is never recycled, so exactly one session speaker holds it (possibly merged since).
    const owner = registry.snapshot().find((s) => s.sonioxLabels.includes(label));
    const speakerId = owner ? (owner.mergedInto ?? owner.sessionSpeakerId) : undefined;
    if (speakerId) last = { speakerId, endSec };
    schedulePersist();
    return speakerId;
  };
  return Object.assign(attribute, { flush: persist });
}
