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
import { addBookmark, createMeeting, updateRecordingMeeting } from '../data/meeting-draft-repository.js';
import { ensureMeetingFolder } from '../data/meeting-folder.js';
import { MeetingClock } from '../data/meeting-clock.js';
import { MediaRecorderService } from '../data/media-recorder-service.js';
import { startHostMicStream } from '../data/host-mic-stream.js';
import { listParts, notifyChunkReady, uploadPart } from '../data/meeting-part-upload.js';
import { PartUploadQueue } from '../data/part-upload-queue.js';
import { createRealtimeClient, type CaptionEvent, type CaptionStatus, type LiveTurn, type RealtimeConnection } from '../data/realtime-client.js';
import { LiveSpeakerPoll, type LiveSpeaker } from '../data/live-speaker-poll.js';
import { speakerResolve, type RealtimeAssignChoice } from '../data/speaker-api.js';
import { ScreenWakeLock, type WakeLockState } from '../data/screen-wake-lock.js';
import type { RealtimeCapabilities, RealtimeToken, SttVendor } from '../data/stt-types.js';
import { TranslateBuffer } from '../data/translate-buffer.js';

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
  /** Raw list from the last `meeting_live_speakers` poll — drives the "Ai đang nói?" chip row. */
  liveSpeakers: LiveSpeaker[];
  /** True once any chunk for this meeting was dropped/failed (S2-08) — "một số đoạn chưa nhận diện được". */
  liveSpeakersDegraded: boolean;
  stageCaptionSize: StageCaptionSize;
  showTranslation: boolean;
  wakeLock: WakeLockState;
  bookmarkAtSec?: number;
  error?: string;
}

export interface StartRecordingInput {
  title: string;
  language: 'vi' | 'en';
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
    speakerMap: {},
    liveSpeakers: [],
    liveSpeakersDegraded: false,
    stageCaptionSize: 'medium',
    showTranslation: false,
    wakeLock: { supported: false, active: false },
  };
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
      // Map the host denial to a DOMException name the UI already classifies.
      const name =
        host.reason === 'not_declared' ? 'NotSupportedError' : host.reason === 'unavailable' ? 'NotFoundError' : 'NotAllowedError';
      throw new DOMException(`Microphone denied by host: ${host.reason}`, name);
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
    try {
      // Guard the async host context: without a room every downstream call
      // (meeting row, Files folder, realtime token) is meaningless, and a
      // create would persist an orphaned meeting with an empty roomId.
      if (!this.ctx.roomId) throw new Error('Chưa nhận được ngữ cảnh phòng từ Hub — thử lại sau giây lát.');
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
        translationLang: input.language === 'vi' ? 'en' : 'vi',
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
        (part) => {
          this.uploadQueue?.enqueue(part.seq, part.blob);
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
      // "Hệ thống đang ghi tối đa N cuộc họp" — recording keeps going, only captions are unavailable.
      this.setState({ captionStatus: 'capacity', error: message });
      return;
    }
    this.setState({ provider: token.provider, capabilities: token.capabilities });

    if (!token.capabilities.translation && translationEnabled) {
      this.translateBuffer = new TranslateBuffer(this.app, {
        roomId: this.ctx.roomId,
        meetingId,
        target: 'en',
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
        onUpdate: (map) => this.applySpeakerMap(map),
        onSpeakersUpdate: (speakers, meta) => {
          this.setState({ liveSpeakers: speakers, liveSpeakersDegraded: meta.degraded });
          void this.reconcilePendingAssignments(); // a new session speaker may now cover an early manual assignment
        },
      });
    }

    this.realtime = await createRealtimeClient(token.provider, {
      stream: this.stream!,
      recorderEpochMs: this.state.recorderEpochMs,
      translate: token.capabilities.translation && translationEnabled,
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
      onTurns: (turns) => {
        this.allTurns = turns;
      },
      onStatus: (status) => this.setState({ captionStatus: status }),
    });
  }

  private applySpeakerMap(map: Map<string, LiveSpeaker>): void {
    const speakerMap = { ...this.state.speakerMap };
    for (const [key, speaker] of map) {
      speakerMap[key] = {
        displayName: speaker.displayName,
        colorKey: speaker.colorKey || speakerMap[key]?.colorKey || this.nextColor(),
        liveConfidence: speaker.liveConfidence,
        resolved: speaker.resolved,
      };
    }
    // Relabel every rendered line's badge only — never touch `text`.
    this.setState({ speakerMap });
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
   * For every pending manual assignment, find the session speaker whose
   * `sonioxLabels` now include that realtime key and persist the identity via
   * `speaker_resolve` (enrolling the voiceprint). Runs after each live-speaker
   * poll and right after a manual assignment; single-flighted so overlapping
   * polls do not double-resolve. A `not_found` (session speaker not written
   * yet) leaves the assignment pending for a later poll.
   */
  private async reconcilePendingAssignments(): Promise<void> {
    if (this.reconciling || this.pendingAssignments.size === 0 || !this.state.meetingId) return;
    this.reconciling = true;
    try {
      for (const [speakerKey, choice] of [...this.pendingAssignments]) {
        const session = this.state.liveSpeakers.find(
          (s) => !s.mergedInto && s.sonioxLabels.some((lbl) => lbl.split('@')[0] === speakerKey),
        );
        if (!session) continue; // no session speaker yet — keep it pending
        try {
          const [result] = await speakerResolve(this.app, this.ctx.roomId, this.state.meetingId, [
            { speakerId: session.sessionSpeakerId, mode: choice.mode, displayName: choice.displayName, privosUserId: choice.privosUserId, profileId: choice.profileId },
          ]);
          if (result?.reason === 'not_found') continue; // row not written yet; retry next poll
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

  private async handleUpload(meetingId: string, folderId: string, part: { seq: number; blob: Blob }): Promise<void> {
    await uploadPart(this.app, { roomId: this.ctx.roomId, folderId, meetingId, seq: part.seq, blob: part.blob });
    this.nextPartSeq = Math.max(this.nextPartSeq, part.seq + 1);
    const nowElapsedMs = performance.now() - this.state.recorderEpochMs;
    const durationMs = this.clock?.measuredPartMs(nowElapsedMs) ?? 60_000;
    void updateRecordingMeeting(this.app, meetingId, { partCount: this.nextPartSeq, lastPartAt: new Date().toISOString() });

    if (this.state.capabilities?.speakerLabels && this.clock) {
      const windowStart = nowElapsedMs - durationMs;
      const segments = this.clock
        .turnsInPart(this.allTurns, { seq: part.seq, startMs: windowStart, endMs: nowElapsedMs })
        .map((t) => ({ speaker: t.speakerKey, startMs: t.startMs, endMs: t.endMs, final: t.final }));
      await notifyChunkReady(this.app, { roomId: this.ctx.roomId, meetingId, seq: part.seq, durationMs, segments });
    }
  }

  // -------------------------------------------------------------- controls

  toggleMute(): void {
    if (!this.stream) return;
    const nextMuted = !this.state.muted;
    for (const track of this.stream.getAudioTracks()) track.enabled = !nextMuted;
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

  setStageCaptionSize(size: StageCaptionSize): void {
    this.setState({ stageCaptionSize: size });
  }

  setShowTranslation(showTranslation: boolean): void {
    this.setState({ showTranslation });
    this.translateBuffer?.setEnabled(showTranslation);
  }

  async addBookmark(): Promise<void> {
    if (!this.state.meetingId) return;
    const atSec = this.state.elapsedSec;
    await addBookmark(this.app, { meetingId: this.state.meetingId, atSec, createdBy: this.ctx.userId });
    this.setState({ bookmarkAtSec: atSec });
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
