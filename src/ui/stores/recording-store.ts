/**
 * The recording state machine: idle → recording → paused → ending →
 * uploading → done/error. Owns every live-recording collaborator (mic
 * stream, MediaRecorder, upload queue, meeting clock, realtime connection,
 * translate buffer, live-speaker poll, wake lock) and exposes one
 * `RecordingState` snapshot via `useSyncExternalStore`. A single instance is
 * created once per app mount (`RecordingStoreProvider`) so state survives the
 * `new` → `live` route change.
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { createElement } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

import { folderName, slugify } from '../../shared/meeting-slug.js';
import { deleteBookmark, listBookmarks } from '../data/bookmark-read-model.js';
import { addBookmark, createMeeting, updateRecordingMeeting } from '../data/meeting-draft-repository.js';
import { ensureMeetingFolder } from '../data/meeting-folder.js';
import { MeetingClock } from '../data/meeting-clock.js';
import { MediaRecorderService } from '../data/media-recorder-service.js';
import { startHostMicStream } from '../data/host-mic-stream.js';
import { listParts, notifyChunkReady, uploadPart } from '../data/meeting-part-upload.js';
import { uploadLiveCaptions, type CaptionExportLine } from '../data/meeting-caption-upload.js';
import { PartUploadQueue } from '../data/part-upload-queue.js';
import { createRealtimeClient, type CaptionEvent, type CaptionStatus, type LiveTurn, type RealtimeConnection } from '../data/realtime-client.js';
import { LiveSpeakerPoll, type LiveSpeaker, type ServerTurn } from '../data/live-speaker-poll.js';
import { speakerResolve, type RealtimeAssignChoice } from '../data/speaker-api.js';
import { ScreenWakeLock, type WakeLockState } from '../data/screen-wake-lock.js';
import type { RealtimeCapabilities, RealtimeToken, SttVendor } from '../data/stt-types.js';
import { TranslateBuffer } from '../data/translate-buffer.js';
import type { LanguageCode } from '../../shared/languages.js';

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'ending' | 'uploading' | 'done' | 'error';
export type StageCaptionSize = 'small' | 'medium' | 'large';

export interface CaptionLine {
  id: string;
  text: string;
  translation?: string;
  atSec: number;
  endSec: number;
  isFinal: boolean;
  speakerKey?: string;
  lang?: string;
}

export interface LiveSpeakerBadge {
  displayName?: string;
  colorKey: string;
  liveConfidence?: number;
  resolved: boolean;
}

export interface RecordingState {
  meetingId: string | null;
  title: string;
  folderId: string | null;
  status: RecordingStatus;
  provider: SttVendor | null;
  capabilities: RealtimeCapabilities | null;
  recorderEpochMs: number;
  startedAt: number;
  elapsedSec: number;
  muted: boolean;
  captionStatus: CaptionStatus | 'capacity';
  sessionIndex: number;
  pendingParts: number;
  clockSkewMs: number;
  lines: CaptionLine[];
  speakerMap: Record<string, LiveSpeakerBadge>;
  /** Manual per-line correction: caption line id -> the speaker key the user says really spoke it. */
  lineSpeaker: Record<string, string>;
  /** "Apply to every line of this voice": a diarized voice key remapped wholesale to another speaker key. */
  voiceAlias: Record<string, string>;
  /** Server turn identity resolved ONCE per poll (`matchTurnsToLines`): caption line id -> the `sessionSpeakerId` a settled turn overlapping it belongs to. Read (never scanned) by `resolveLineSpeakerKey` on every render. */
  lineServerSpeaker: Record<string, string>;
  /** Raw list from the last `meeting_live_speakers` poll — drives the "Who's speaking?" chip row. */
  liveSpeakers: LiveSpeaker[];
  /** True once any chunk for this meeting was dropped/failed (S2-08) — "some segments could not be identified". */
  liveSpeakersDegraded: boolean;
  stageCaptionSize: StageCaptionSize;
  showTranslation: boolean;
  wakeLock: WakeLockState;
  bookmarkAtSec?: number;
  /** Rounded atSec of every caption line the user has bookmarked this session — drives the filled/ticked bookmark icon per line. */
  bookmarkedSecs: number[];
  /** Rounded atSec → its bookmark row id, so a second tap (or the side panel's ×) can delete it. */
  bookmarkIdsBySec: Record<number, string>;
  /** Bumped on every bookmark add/remove so the side panel refetches its list. */
  bookmarkRev: number;
  error?: string;
}

export interface StartRecordingInput {
  title: string;
  language: LanguageCode;
  /** Bilingual-translation target language (only used when `translationEnabled`). */
  translationLang: LanguageCode;
  translationEnabled: boolean;
}

const PALETTE = ['blue', 'gold', 'green', 'purple', 'red', 'teal'];

function initialState(): RecordingState {
  return {
    meetingId: null,
    title: '',
    folderId: null,
    status: 'idle',
    provider: null,
    capabilities: null,
    recorderEpochMs: 0,
    startedAt: 0,
    elapsedSec: 0,
    muted: false,
    captionStatus: 'off',
    sessionIndex: 0,
    pendingParts: 0,
    clockSkewMs: 0,
    lines: [],
    bookmarkedSecs: [],
    bookmarkIdsBySec: {},
    bookmarkRev: 0,
    speakerMap: {},
    lineSpeaker: {},
    voiceAlias: {},
    lineServerSpeaker: {},
    liveSpeakers: [],
    liveSpeakersDegraded: false,
    stageCaptionSize: 'medium',
    showTranslation: false,
    wakeLock: { supported: false, active: false },
  };
}

/**
 * Follows a session speaker's `mergedInto` chain to its ultimate winner, using
 * only the small `liveSpeakers` list (never a scan of lines/turns) — a
 * `lineServerSpeaker` entry set on an earlier poll can still point at a since
 * -merged loser (the merge is only reflected in NEW turns going forward), so
 * this is resolved at read time instead of eagerly rewriting every stored
 * entry. Cycle-guarded defensively; a real cycle should never occur.
 */
function resolveMergedSpeakerId(id: string, speakers: readonly LiveSpeaker[]): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const speaker = speakers.find((s) => s.sessionSpeakerId === current);
    if (!speaker?.mergedInto) return current;
    current = speaker.mergedInto;
  }
  return current;
}

/**
 * Who a caption line belongs to, in order: a per-line override, then a
 * whole-voice alias, then the SERVER's own turn-level identity (resolved once
 * per poll into `lineServerSpeaker` by {@link matchTurnsToLines} — a single
 * map read here, never a scan), then finally whatever the diarizer's realtime
 * label said (the ~60-90s before any turn has settled, or a provider with no
 * turn feed at all). The diarizer mixes voices up, so the user can fix one
 * segment or a whole voice.
 */
export function resolveLineSpeakerKey(
  state: Pick<RecordingState, 'lineSpeaker' | 'voiceAlias' | 'lineServerSpeaker' | 'liveSpeakers'>,
  line: Pick<CaptionLine, 'id' | 'speakerKey'>,
): string | undefined {
  const override = state.lineSpeaker[line.id];
  if (override) return override;
  if (line.speakerKey) {
    const alias = state.voiceAlias[line.speakerKey];
    if (alias) return alias;
  }
  const serverId = state.lineServerSpeaker[line.id];
  if (serverId) return resolveMergedSpeakerId(serverId, state.liveSpeakers);
  return line.speakerKey;
}

/** A settled turn already newer than the previous poll's cursor plus the base label it was embedded under — the shape both `matchTurnsToLines` and `accumulateLabelSpeech`/`ownerForLabel` operate on. */
type ResolvedTurn = ServerTurn;

/** Only the most recent lines are ever worth checking against a NEW turn — a settled turn always corresponds to something spoken within the last chunk-processing cycle, never meeting history. Keeps the per-poll matcher's cost bounded regardless of how long the meeting has run. */
const RECENT_LINES_WINDOW = 500;
/** A line counts as "this turn's line" once the turn covers at least half of the line's own timespan — the same bar plan.md sets for the server-identity resolution step. */
const TURN_LINE_OVERLAP_RATIO = 0.5;

/**
 * New settled turns (this poll only) matched against a bounded recent-lines
 * window -> a `lineServerSpeaker` patch. Matches by base realtime label (a
 * recycled label's OLD and NEW turns share the same raw label — only time
 * tells them apart) plus >=50% time overlap; never scans the full line
 * history (see `RECENT_LINES_WINDOW`). Exported for direct unit testing.
 */
export function matchTurnsToLines(lines: readonly CaptionLine[], turns: readonly ResolvedTurn[]): Record<string, string> {
  if (turns.length === 0) return {};
  const candidates = lines.slice(-RECENT_LINES_WINDOW);
  const patch: Record<string, string> = {};
  for (const turn of turns) {
    const baseLabel = turn.label.split('@')[0];
    let bestLine: CaptionLine | undefined;
    let bestRatio = 0;
    for (const line of candidates) {
      if (!line.speakerKey || line.speakerKey.split('@')[0] !== baseLabel) continue;
      const lineStartMs = line.atSec * 1000;
      const lineEndMs = line.endSec * 1000;
      const lineDurMs = Math.max(1, lineEndMs - lineStartMs);
      const overlapMs = Math.min(turn.endMs, lineEndMs) - Math.max(turn.startMs, lineStartMs);
      const ratio = overlapMs / lineDurMs;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestLine = line;
      }
    }
    if (bestLine && bestRatio >= TURN_LINE_OVERLAP_RATIO) patch[bestLine.id] = turn.sessionSpeakerId;
  }
  return patch;
}

/** Adds this poll's new turns' speech duration onto a running `baseLabel -> sessionSpeakerId -> ms` tally — the only source {@link ownerForLabel} needs to break a recycled label's tie by majority speech. Mutates `tally` in place. */
export function accumulateLabelSpeech(tally: Map<string, Map<string, number>>, turns: readonly ResolvedTurn[]): void {
  for (const turn of turns) {
    const baseLabel = turn.label.split('@')[0];
    let bySpeaker = tally.get(baseLabel);
    if (!bySpeaker) {
      bySpeaker = new Map();
      tally.set(baseLabel, bySpeaker);
    }
    bySpeaker.set(turn.sessionSpeakerId, (bySpeaker.get(turn.sessionSpeakerId) ?? 0) + Math.max(0, turn.endMs - turn.startMs));
  }
}

/**
 * The session speaker that CURRENTLY owns a realtime label — the target for
 * both a pending manual name and speakerMap chip folding. A label held by
 * exactly one live (non-merged) session speaker resolves trivially; a
 * RECYCLED label held by two resolves to whichever has spoken more of it so
 * far (`tally`), falling back to the first-listed candidate when no speech
 * has been tallied for it yet (e.g. the very poll that just created the
 * second one). `undefined` when no live session speaker has claimed the label
 * at all.
 */
export function ownerForLabel(baseLabel: string, speakers: readonly LiveSpeaker[], tally: ReadonlyMap<string, ReadonlyMap<string, number>>): LiveSpeaker | undefined {
  const candidates = speakers.filter((s) => !s.mergedInto && s.sonioxLabels.some((l) => l.split('@')[0] === baseLabel));
  if (candidates.length <= 1) return candidates[0];
  const speech = tally.get(baseLabel);
  if (!speech) return candidates[0];
  let best = candidates[0];
  let bestMs = speech.get(best.sessionSpeakerId) ?? 0;
  for (const candidate of candidates.slice(1)) {
    const ms = speech.get(candidate.sessionSpeakerId) ?? 0;
    if (ms > bestMs) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}

/**
 * Folds each realtime label's chip into its OWNING session speaker's own chip
 * (name/colour/`resolved` carried over), re-keyed from now on by
 * `sessionSpeakerId` — the server-confirmed `displayName`/`colorKey`/
 * `resolved` always wins over whatever the label chip locally guessed, once
 * the server has an opinion. A label nobody has claimed yet (no live session
 * speaker owns it) keeps its own untouched entry — "labels with no session
 * speaker yet keep their own chip" (plan.md).
 */
export function foldSpeakerMap(
  speakerMap: Record<string, LiveSpeakerBadge>,
  speakers: readonly LiveSpeaker[],
  tally: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Record<string, LiveSpeakerBadge> {
  const next = { ...speakerMap };
  for (const speaker of speakers) {
    if (speaker.mergedInto) continue;
    const bareLabels = [...new Set(speaker.sonioxLabels.map((l) => l.split('@')[0]))];
    let folded: LiveSpeakerBadge | undefined;
    for (const label of bareLabels) {
      const existing = next[label];
      if (!existing) continue;
      if (ownerForLabel(label, speakers, tally)?.sessionSpeakerId !== speaker.sessionSpeakerId) continue; // this speaker isn't (yet) the label's current owner — leave its chip alone
      folded = existing;
      delete next[label];
    }
    const prev = next[speaker.sessionSpeakerId] ?? folded;
    next[speaker.sessionSpeakerId] = {
      displayName: speaker.displayName ?? prev?.displayName,
      colorKey: speaker.colorKey || prev?.colorKey || PALETTE[Object.keys(next).length % PALETTE.length],
      liveConfidence: speaker.liveConfidence ?? prev?.liveConfidence,
      resolved: speaker.resolved || Boolean(prev?.resolved),
    };
  }
  return next;
}

/** Merge one caption event into the line list: upsert by id, else promote the most recent still-draft line to final. */
function applyCaption(lines: CaptionLine[], event: CaptionEvent, speakerMap: Record<string, LiveSpeakerBadge>): CaptionLine[] {
  const existingIndex = lines.findIndex((l) => l.id === event.id);
  if (event.translationOf) {
    const target = lines.findIndex((l) => l.id === event.translationOf);
    if (target >= 0) {
      const next = [...lines];
      next[target] = { ...next[target], translation: event.text };
      return next;
    }
    return lines;
  }
  // Register a newly seen speaker BEFORE any early return below — otherwise a
  // line can render with a speaker the map does not know ("speaker 0").
  if (event.speakerKey && !speakerMap[event.speakerKey]) {
    speakerMap[event.speakerKey] = { colorKey: PALETTE[Object.keys(speakerMap).length % PALETTE.length], resolved: false };
  }
  const asLine = (): CaptionLine => ({
    id: event.id,
    text: event.text,
    atSec: event.atSec,
    endSec: event.endSec,
    isFinal: event.kind === 'final',
    speakerKey: event.speakerKey,
    lang: event.lang,
  });
  if (existingIndex >= 0) {
    const next = [...lines];
    next[existingIndex] = { ...next[existingIndex], ...asLine(), id: lines[existingIndex].id };
    return next;
  }
  // Providers WITHOUT stable line ids (ElevenLabs: a rolling `draft` id, then a
  // fresh id per committed line) need the final to take over the open draft.
  // Speaker-labelled providers (Soniox) carry a stable id per speaker turn and
  // upsert above — letting a new turn's final replace "the latest draft" here
  // overwrote the PREVIOUS speaker's line and erased the visible history.
  if (event.kind === 'final' && !event.speakerKey) {
    const draftIndex = [...lines].reverse().findIndex((l) => !l.isFinal && !l.speakerKey);
    if (draftIndex >= 0) {
      const realIndex = lines.length - 1 - draftIndex;
      const next = [...lines];
      next[realIndex] = asLine();
      return next;
    }
  }
  return [...lines, asLine()];
}

export class RecordingStore {
  private state: RecordingState = initialState();
  private listeners = new Set<() => void>();

  private meetingLanguage: LanguageCode = 'vi';
  private translationTarget: LanguageCode = 'en';
  private stream: MediaStream | null = null;
  /** Releases the active capture (host-brokered stop, or getUserMedia track stop). */
  private micStop: (() => void) | null = null;
  private recorder: MediaRecorderService | null = null;
  private uploadQueue: PartUploadQueue | null = null;
  private clock: MeetingClock | null = null;
  private realtime: RealtimeConnection | null = null;
  private wakeLock: ScreenWakeLock | null = null;
  private translateBuffer: TranslateBuffer | null = null;
  private speakerPoll: LiveSpeakerPoll | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private allTurns: LiveTurn[] = [];
  private nextPartSeq = 0;
  /** Manual early assignments keyed by REALTIME speaker key, awaiting a session speaker to enrol against. */
  private pendingAssignments = new Map<string, RealtimeAssignChoice>();
  private reconciling = false;
  /** Running `baseLabel -> sessionSpeakerId -> speechMs` tally built from every poll's new turns — the only input {@link ownerForLabel} needs to break a recycled label's tie by majority speech. */
  private readonly labelSpeechMsBySpeaker = new Map<string, Map<string, number>>();

  constructor(
    private readonly app: McpApp,
    private ctx: { roomId: string; userId: string; username: string },
  ) {}

  /**
   * Refresh the host context. The store is a mount-lived singleton constructed
   * on the FIRST render, when the host may not have delivered `roomId`/`userId`
   * yet (they arrive asynchronously over the postMessage bridge) — capturing
   * them once would leave `ctx.roomId` empty and write orphaned meetings with
   * no room. The provider re-syncs on every render; never mid-recording, so a
   * live session keeps the room it started in.
   */
  syncContext(next: { roomId: string; userId: string; username: string }): void {
    if (this.state.status === 'recording' || this.state.status === 'paused') return;
    if (next.roomId) this.ctx = next;
  }

  getState = (): RecordingState => this.state;

  /** The live mic stream, for display-only consumers (mic level meter). Never exposed in `RecordingState` itself. */
  getStream(): MediaStream | null {
    return this.stream;
  }

  /**
   * Acquire the mic as a MediaStream, host-brokered first (works in the opaque
   * origin) and falling back to direct getUserMedia only when the host predates
   * brokered devices. Sets `this.micStop` to the matching release. Throws a
   * DOMException whose `name` the start screen maps to a user-facing message.
   */
  private async acquireMicStream(): Promise<MediaStream> {
    const host = await startHostMicStream(this.app, { sampleRate: 16000, echoCancellation: true, noiseSuppression: true });
    if (host.kind === 'stream') {
      this.micStop = host.stop;
      return host.stream;
    }
    if (host.kind === 'denied') {
      if (host.reason === 'not_declared') {
        throw new DOMException('Microphone not declared by host', 'NotSupportedError');
      }
      if (host.reason === 'unavailable') {
        // The host collapses "no capture device" and "device busy" into one
        // `unavailable` reason. Probe the device list to tell them apart so the
        // UI can advise correctly: a present-but-unusable mic → NotReadableError
        // ("in use"), none at all → NotFoundError ("no microphone").
        const name = (await this.hasAudioInputDevice()) ? 'NotReadableError' : 'NotFoundError';
        throw new DOMException(`Microphone unavailable on host: ${host.reason}`, name);
      }
      // denied | user_activation_required — a permission/gesture problem.
      throw new DOMException(`Microphone denied by host: ${host.reason}`, 'NotAllowedError');
    }
    // Older host without brokered capture — direct getUserMedia (only succeeds
    // if this frame is not opaque-origin).
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('Microphone API unavailable in this context', 'NotSupportedError');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    this.micStop = () => {
      for (const track of stream.getTracks()) track.stop();
    };
    return stream;
  }

  /**
   * Whether the machine exposes any audio-input device. `enumerateDevices`
   * lists an `audioinput` entry (with an empty label, pre-permission) when a mic
   * exists, so a missing entry means there is genuinely no microphone. Any probe
   * failure is treated as "no device" — the safe default for the caller's
   * not-found vs. busy split.
   */
  private async hasAudioInputDevice(): Promise<boolean> {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return false;
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((device) => device.kind === 'audioinput');
    } catch {
      return false;
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(patch: Partial<RecordingState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Next color in the fixed palette, by discovery order — not keyed off the speakerKey itself. */
  private nextColor(): string {
    const count = Object.keys(this.state.speakerMap).length;
    return PALETTE[count % PALETTE.length];
  }

  // ---------------------------------------------------------------- start

  async startRecording(input: StartRecordingInput): Promise<void> {
    this.meetingLanguage = input.language;
    this.translationTarget = input.translationLang;
    try {
      // Guard the async host context: without a room every downstream call
      // (meeting row, Files folder, realtime token) is meaningless, and a
      // create would persist an orphaned meeting with an empty roomId.
      if (!this.ctx.roomId) throw new Error('Room context not received from Hub yet — try again in a moment.');
      // This document runs in an opaque origin, where the browser refuses
      // `getUserMedia` even with `allow="microphone"` delegated. Capture through
      // the host (it records under its own origin) and rebuild a MediaStream the
      // recorder + realtime SDK can consume. An older host without brokered mic
      // returns `unsupported` — only then fall back to direct getUserMedia.
      const stream = await this.acquireMicStream();
      this.stream = stream;

      this.wakeLock = new ScreenWakeLock({ onChange: (wakeLock) => this.setState({ wakeLock }) });
      void this.wakeLock.acquire(); // must run inside this click-gesture call chain

      // The App DB assigns `_id` server-side, so the meeting record is created
      // FIRST (without `folderId`, which the schema allows to be empty) — the
      // real `meetingId` is what every tool call and file name needs
      // (`meeting_realtime_token`/`meeting_chunk_ready` look meetings up by
      // this same id). The folder is created right after, using that real id
      // for `meetingId8`, then patched onto the meeting record.
      const startedAtIso = new Date().toISOString();
      const { meetingId } = await createMeeting(this.app, {
        roomId: this.ctx.roomId,
        title: input.title,
        slug: slugify(input.title),
        language: input.language,
        translationEnabled: input.translationEnabled,
        translationLang: input.translationLang,
        keepAudio: true,
        ownerUserId: this.ctx.userId,
        startedAt: startedAtIso,
      });

      const folderPath = folderName(input.title, meetingId);
      const folderId = await ensureMeetingFolder(this.app, this.ctx.roomId, folderPath);
      await updateRecordingMeeting(this.app, meetingId, { folderId });

      const recorderEpochMs = performance.now();
      this.clock = new MeetingClock(recorderEpochMs);
      this.nextPartSeq = 0;
      this.allTurns = [];

      this.setState({
        meetingId,
        title: input.title,
        folderId,
        status: 'recording',
        recorderEpochMs,
        startedAt: Date.now(),
        showTranslation: input.translationEnabled,
      });

      this.uploadQueue = new PartUploadQueue(
        (part) => this.handleUpload(meetingId, folderId, part),
        {
          // Mirrors the server's LIVE_UPLOAD_RETRY_WINDOW_MIN default (env.ts)
          // — the iframe has no way to read that env var, so this is a fixed
          // default rather than a live setting.
          retryWindowMin: 15,
          onPendingCountChange: (count) => this.setState({ pendingParts: count }),
          onCapReached: () => this.setState({ error: 'upload-cap-reached' }),
        },
      );

      this.recorder = new MediaRecorderService(
        stream,
        recorderEpochMs,
        (part) => {
          this.uploadQueue?.enqueue(part.seq, part.blob, part.partStartMs, part.durationMs);
        },
        () => this.setState({ error: 'recorder-error' }),
      );
      this.recorder.start();

      this.timer = setInterval(() => this.tickElapsed(), 1000);

      await this.startRealtime(meetingId, input.translationEnabled);
    } catch (error) {
      // Release the mic if it opened before a later start step failed, so the
      // host capture (and its browser indicator) does not leak.
      this.micStop?.();
      this.micStop = null;
      this.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private tickElapsed(): void {
    if (this.state.status !== 'recording') return;
    this.setState({ elapsedSec: Math.floor((performance.now() - this.state.recorderEpochMs) / 1000) });
  }

  // ------------------------------------------------------------ realtime

  private async startRealtime(meetingId: string, translationEnabled: boolean): Promise<void> {
    let token: RealtimeToken;
    try {
      const raw = await this.app.callServerTool({ name: 'meeting_realtime_token', arguments: { roomId: this.ctx.roomId, meetingId } });
      token = parseToolResult(raw) as unknown as RealtimeToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only the server's concurrency-cap refusal ("The system is already recording the maximum
      // of N meetings") is a capacity problem; any other failure is plain "captions off" — never
      // mislabel it as capacity. Either way the recording itself keeps going.
      this.setState({ captionStatus: /recording the maximum of \d+ meetings/.test(message) ? 'capacity' : 'off', error: message });
      return;
    }
    this.setState({ provider: token.provider, capabilities: token.capabilities });

    if (!token.capabilities.translation && translationEnabled) {
      this.translateBuffer = new TranslateBuffer(this.app, {
        roomId: this.ctx.roomId,
        meetingId,
        target: this.translationTarget,
        onTranslated: (translations) => {
          const lines = [...this.state.lines];
          for (const t of translations) {
            const idx = lines.findIndex((l) => l.id === t.id);
            if (idx >= 0) lines[idx] = { ...lines[idx], translation: t.text };
          }
          this.setState({ lines });
        },
      });
    }

    if (token.capabilities.speakerLabels) {
      this.speakerPoll = new LiveSpeakerPoll(this.app, {
        roomId: this.ctx.roomId,
        meetingId,
        onUpdate: (speakers, turns, meta) => this.applyPollUpdate(speakers, turns, meta),
      });
    }

    this.realtime = await createRealtimeClient(token.provider, {
      stream: this.stream!,
      recorderEpochMs: this.state.recorderEpochMs,
      translate: token.capabilities.translation && translationEnabled,
      translateFrom: this.meetingLanguage,
      translateTo: this.translationTarget,
      mintToken: async () => {
        const raw = await this.app.callServerTool({ name: 'meeting_realtime_token', arguments: { roomId: this.ctx.roomId, meetingId } });
        return parseToolResult(raw) as unknown as RealtimeToken;
      },
      onStarted: (sessionIndex) => {
        this.clock?.registerSessionStart(sessionIndex);
        this.setState({ sessionIndex });
      },
      onCaption: (event) => {
        const speakerMap = { ...this.state.speakerMap };
        const lines = applyCaption(this.state.lines, event, speakerMap);
        this.setState({ lines, speakerMap });
        if (this.translateBuffer && event.kind === 'final' && !event.translationOf) {
          this.translateBuffer.push({ id: event.id, text: event.text, lang: event.lang });
        }
      },
      onLinesSnapshot: (sessionIndex, ids) => {
        // Drop this session's lines the provider no longer has (its draft tail regrouped).
        const prefix = `s${sessionIndex}:turn`;
        const alive = new Set(ids);
        const lines = this.state.lines.filter((l) => !l.id.startsWith(prefix) || alive.has(l.id));
        if (lines.length !== this.state.lines.length) this.setState({ lines });
      },
      onTurns: (turns) => {
        this.allTurns = turns;
      },
      onStatus: (status) => this.setState({ captionStatus: status }),
    });
  }

  /**
   * One `meeting_live_speakers` poll's worth of work, all done ONCE here
   * rather than per render/per line: tally this poll's new turns' speech
   * (for {@link ownerForLabel}'s majority tie-break), resolve them against the
   * recent lines into a `lineServerSpeaker` patch, and fold each label's chip
   * into its owning session speaker's chip. Relabels badges only — never
   * touches caption `text`.
   */
  private applyPollUpdate(speakers: LiveSpeaker[], turns: ServerTurn[], meta: { degraded: boolean; labelsSupported: boolean }): void {
    accumulateLabelSpeech(this.labelSpeechMsBySpeaker, turns);
    const lineServerSpeakerPatch = matchTurnsToLines(this.state.lines, turns);
    const speakerMap = foldSpeakerMap(this.state.speakerMap, speakers, this.labelSpeechMsBySpeaker);
    this.setState({
      liveSpeakers: speakers,
      liveSpeakersDegraded: meta.degraded,
      speakerMap,
      lineServerSpeaker: Object.keys(lineServerSpeakerPatch).length > 0 ? { ...this.state.lineServerSpeaker, ...lineServerSpeakerPatch } : this.state.lineServerSpeaker,
    });
    void this.reconcilePendingAssignments(); // a new/updated session speaker may now cover an early manual assignment
  }

  /**
   * Create a speaker the user can move lines onto ("Add new speaker"). When a
   * name is typed in the picker's search box, it becomes the speaker's label;
   * otherwise it stays an unnamed "Speaker N". Returns its key.
   */
  addManualSpeaker(displayName?: string): string {
    const speakerMap = { ...this.state.speakerMap };
    let n = 1;
    while (speakerMap[`manual:${n}`]) n += 1;
    const key = `manual:${n}`;
    const name = displayName?.trim();
    speakerMap[key] = { colorKey: this.nextColor(), resolved: Boolean(name), ...(name ? { displayName: name } : {}) };
    this.setState({ speakerMap });
    return key;
  }

  /**
   * Correct who spoke a segment. `applyToVoice` moves EVERY line the diarizer
   * gave that voice (now and later) instead of just this one.
   */
  reassignLine(lineId: string, toSpeakerKey: string, applyToVoice: boolean): void {
    const line = this.state.lines.find((l) => l.id === lineId);
    if (!line) return;
    if (applyToVoice && line.speakerKey) {
      const voice = line.speakerKey;
      const voiceAlias = { ...this.state.voiceAlias };
      if (toSpeakerKey === voice) delete voiceAlias[voice];
      else voiceAlias[voice] = toSpeakerKey;
      // Per-line fixes of that voice are superseded by the wholesale move.
      const lineSpeaker = Object.fromEntries(
        Object.entries(this.state.lineSpeaker).filter(([id]) => this.state.lines.find((l) => l.id === id)?.speakerKey !== voice),
      );
      this.setState({ voiceAlias, lineSpeaker });
      return;
    }
    this.setState({ lineSpeaker: { ...this.state.lineSpeaker, [lineId]: toSpeakerKey } });
  }

  /**
   * The user named a REALTIME speaker (from second one). Relabel every line of
   * that speaker immediately and remember the choice; the enrolment is deferred
   * to {@link reconcilePendingAssignments} once a session speaker exists for it.
   * An empty/skip choice clears any pending assignment and the label.
   */
  assignRealtimeSpeaker(speakerKey: string, choice: RealtimeAssignChoice): void {
    const label = choice.displayName?.trim();
    const speakerMap = { ...this.state.speakerMap };
    const prev = speakerMap[speakerKey] ?? { colorKey: this.nextColor(), resolved: false };
    speakerMap[speakerKey] = { ...prev, displayName: label || prev.displayName, resolved: choice.mode !== 'skip' };
    this.setState({ speakerMap });

    if (choice.mode === 'skip') {
      this.pendingAssignments.delete(speakerKey);
      return;
    }
    this.pendingAssignments.set(speakerKey, choice);
    void this.reconcilePendingAssignments();
  }

  /**
   * For every pending manual assignment, find the session speaker that
   * CURRENTLY owns that realtime key ({@link ownerForLabel} — the majority-
   * speech owner when the label has recycled into two session speakers) and
   * persist the identity via `speaker_resolve` (enrolling the voiceprint).
   * Runs after each live-speaker poll and right after a manual assignment;
   * single-flighted so overlapping polls do not double-resolve. A `not_found`
   * (session speaker not written yet) leaves the assignment pending for a
   * later poll.
   */
  private async reconcilePendingAssignments(): Promise<void> {
    if (this.reconciling || this.pendingAssignments.size === 0 || !this.state.meetingId) return;
    this.reconciling = true;
    try {
      for (const [speakerKey, choice] of [...this.pendingAssignments]) {
        const session = ownerForLabel(speakerKey, this.state.liveSpeakers, this.labelSpeechMsBySpeaker);
        if (!session) continue; // no session speaker yet — keep it pending
        try {
          const [result] = await speakerResolve(this.app, this.ctx.roomId, this.state.meetingId, [
            { speakerId: session.sessionSpeakerId, mode: choice.mode, displayName: choice.displayName, privosUserId: choice.privosUserId, profileId: choice.profileId },
          ]);
          if (result?.reason === 'not_found') continue; // row not written yet; retry next poll
          // Any other reason — including `enrol_deferred` (named, but the live voiceprint cluster
          // isn't enrol-worthy yet; the post-meeting job carries the load from here) — is treated as a
          // SUCCESSFUL name assignment: the identity is already persisted server-side either way, and
          // there is no client retry loop for enrolment itself (plan.md § Requirements).
          this.pendingAssignments.delete(speakerKey);
          const displayName = result?.displayName ?? choice.displayName ?? this.state.speakerMap[speakerKey]?.displayName ?? '';
          const liveSpeakers = this.state.liveSpeakers.map((s) =>
            s.sessionSpeakerId === session.sessionSpeakerId ? { ...s, displayName, resolved: true } : s,
          );
          this.setState({ liveSpeakers });
        } catch {
          // Transient (relay blip): keep it pending for the next poll.
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  // -------------------------------------------------------------- upload

  private async handleUpload(
    meetingId: string,
    folderId: string,
    part: { seq: number; blob: Blob; partStartMs: number; durationMs: number },
  ): Promise<void> {
    await uploadPart(this.app, { roomId: this.ctx.roomId, folderId, meetingId, seq: part.seq, blob: part.blob });
    this.nextPartSeq = Math.max(this.nextPartSeq, part.seq + 1);
    void updateRecordingMeeting(this.app, meetingId, { partCount: this.nextPartSeq, lastPartAt: new Date().toISOString() });

    if (this.state.capabilities?.speakerLabels && this.clock) {
      // The window comes straight from the part's own emit-time stamps — never
      // from wall time measured HERE (which would still be skewed by however
      // long `uploadPart` just took, the original bug this fixes).
      const segments = this.clock
        .turnsInPart(this.allTurns, { seq: part.seq, startMs: part.partStartMs, endMs: part.partStartMs + part.durationMs })
        .map((t) => ({ speaker: t.speakerKey, startMs: t.startMs, endMs: t.endMs, final: t.final }));
      await notifyChunkReady(this.app, { roomId: this.ctx.roomId, meetingId, seq: part.seq, durationMs: part.durationMs, partStartMs: part.partStartMs, segments });
    }

    // Persist the caption TEXT alongside the audio, on the same ~60s cadence, so
    // the on-screen transcript survives a closed tab before reprocessing runs.
    await this.pushLiveCaptions(meetingId, folderId);
  }

  /** Best-effort snapshot of the finalized caption lines (with resolved speaker names) to Files. Never throws. */
  private async pushLiveCaptions(meetingId: string, folderId: string): Promise<void> {
    const speakerKeys = Object.keys(this.state.speakerMap);
    const lines: CaptionExportLine[] = this.state.lines
      .filter((line) => line.isFinal && line.text.trim())
      .map((line) => {
        const key = resolveLineSpeakerKey(this.state, line);
        const speakerName = key
          ? this.state.speakerMap[key]?.displayName ?? `#${speakerKeys.indexOf(key) + 1}`
          : undefined;
        return { atSec: Math.round(line.atSec), speakerKey: key, speakerName, text: line.text.trim(), translation: line.translation };
      });
    if (lines.length === 0) return;
    try {
      await uploadLiveCaptions(this.app, { roomId: this.ctx.roomId, folderId, meetingId, title: this.state.title, lines });
    } catch (error) {
      console.warn('uploadLiveCaptions failed (captions will still be reprocessed from audio):', error);
    }
  }

  // -------------------------------------------------------------- controls

  toggleMute(): void {
    if (!this.recorder) return;
    const nextMuted = !this.state.muted;
    // `MediaRecorderService` owns `track.enabled` (it combines mute AND pause)
    // so pausing after this still respects the mute state, and resuming
    // restores it instead of unconditionally un-muting.
    this.recorder.setMuted(nextMuted);
    this.setState({ muted: nextMuted });
  }

  togglePause(): void {
    if (this.state.status === 'recording') {
      this.recorder?.pause();
      void this.wakeLock?.release();
      this.setState({ status: 'paused' });
    } else if (this.state.status === 'paused') {
      this.recorder?.resume();
      void this.wakeLock?.acquire();
      this.setState({ status: 'recording' });
    }
  }

  /** Rename the meeting live (persists the new title on the meetings row). */
  setTitle(title: string): void {
    const next = title.trim();
    if (!next || next === this.state.title) return;
    this.setState({ title: next });
    if (this.state.meetingId) void updateRecordingMeeting(this.app, this.state.meetingId, { title: next }).catch(() => undefined);
  }

  setStageCaptionSize(size: StageCaptionSize): void {
    this.setState({ stageCaptionSize: size });
  }

  setShowTranslation(showTranslation: boolean): void {
    this.setState({ showTranslation });
    this.translateBuffer?.setEnabled(showTranslation);
  }

  /**
   * Bookmark ONE caption segment. `atSec` is that line's start (rounded); `quote`
   * is a short snippet of its text. Falls back to the current elapsed time when
   * called with no line (legacy footer button). Re-adding a segment already
   * bookmarked is a no-op — the caller toggles off via {@link removeBookmark}.
   */
  async addBookmark(atSec?: number, quote?: string): Promise<void> {
    if (!this.state.meetingId) return;
    const at = Math.round(atSec ?? this.state.elapsedSec);
    if (this.state.bookmarkedSecs.includes(at)) return; // already bookmarked this segment
    const snippet = quote ? quote.trim().slice(0, 140) : undefined;
    const { bookmarkId } = await addBookmark(this.app, { meetingId: this.state.meetingId, atSec: at, createdBy: this.ctx.userId, quote: snippet });
    this.setState({
      bookmarkAtSec: at,
      bookmarkedSecs: [...this.state.bookmarkedSecs, at],
      bookmarkIdsBySec: { ...this.state.bookmarkIdsBySec, [at]: bookmarkId },
      bookmarkRev: this.state.bookmarkRev + 1,
    });
  }

  /**
   * Remove the bookmark on a segment (a second tap of a ticked caption line, or
   * the side panel's × button). Resolves the bookmark row id from the session
   * map, falling back to a lookup for a bookmark made before this state tracked
   * ids (e.g. a resumed session). Best-effort delete — the local state is
   * cleared regardless so the UI reflects the user's intent immediately.
   */
  async removeBookmark(atSec: number): Promise<void> {
    if (!this.state.meetingId) return;
    const at = Math.round(atSec);
    let id: string | undefined = this.state.bookmarkIdsBySec[at];
    if (!id) {
      const existing = await listBookmarks(this.app, this.state.meetingId).catch(() => []);
      id = existing.find((b) => Math.round(b.atSec) === at)?.id;
    }
    if (id) await deleteBookmark(this.app, id).catch(() => undefined);
    const remainingIds = { ...this.state.bookmarkIdsBySec };
    delete remainingIds[at];
    this.setState({
      bookmarkedSecs: this.state.bookmarkedSecs.filter((s) => s !== at),
      bookmarkIdsBySec: remainingIds,
      bookmarkRev: this.state.bookmarkRev + 1,
    });
  }

  // ------------------------------------------------------------------ end

  async endAndSummarize(): Promise<void> {
    if (!this.state.meetingId) return;
    const meetingId = this.state.meetingId;
    this.setState({ status: 'ending' });

    await this.recorder?.stop();
    await this.realtime?.stop();
    this.speakerPoll?.stop();
    this.translateBuffer?.dispose();
    if (this.timer) clearInterval(this.timer);
    await this.wakeLock?.release();
    this.micStop?.(); // release the host capture (or getUserMedia tracks)
    this.micStop = null;

    // Give the upload queue a chance to drain the final part(s) before moving on.
    this.uploadQueue?.retry();
    const deadline = Date.now() + 30_000;
    while ((this.uploadQueue?.pendingCount ?? 0) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Final caption flush so the last (<60s) lines are saved before processing.
    if (this.state.folderId) await this.pushLiveCaptions(meetingId, this.state.folderId);

    const parts = this.state.folderId ? await listParts(this.app, this.ctx.roomId, this.state.folderId).catch(() => []) : [];
    const durationSec = Math.floor((performance.now() - this.state.recorderEpochMs) / 1000);
    await updateRecordingMeeting(this.app, meetingId, {
      endedAt: new Date().toISOString(),
      durationSec,
      partCount: Math.max(this.nextPartSeq, parts.length),
      sttSessionMeta: this.clock?.toSttSessionMeta(),
      status: 'uploading',
    });

    try {
      const raw = await this.app.callServerTool({ name: 'meeting_process', arguments: { roomId: this.ctx.roomId, meetingId } });
      parseToolResult(raw);
    } catch (error) {
      // The processing screen shows its own retry button — a failed enqueue here must not block navigation to it.
      console.warn('meeting_process failed (retry is available on the processing screen):', error);
    }

    this.setState({ status: 'done' });
  }
}

const RecordingStoreContext = createContext<RecordingStore | null>(null);

let singleton: RecordingStore | null = null;

export function RecordingStoreProvider({ children }: { children: ReactNode }) {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const ctx = { roomId: context.roomId, userId: context.userId, username: context.username };
  if (!singleton) {
    singleton = new RecordingStore(app, ctx);
  }
  // Host context (roomId/userId) is delivered asynchronously and may be empty
  // on the first render that built the singleton — keep it fresh so a recording
  // never starts against an empty room.
  singleton.syncContext(ctx);
  return createElement(RecordingStoreContext.Provider, { value: singleton }, children);
}

export function useRecordingStore(): RecordingStore {
  const store = useContext(RecordingStoreContext);
  if (!store) throw new Error('useRecordingStore must be used inside a RecordingStoreProvider.');
  return store;
}

export function useRecordingState(): RecordingState {
  const store = useRecordingStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
