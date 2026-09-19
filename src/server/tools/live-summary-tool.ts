/**
 * `meeting_live_summary {roomId, meetingId, title?, language?, segments}` —
 * an ON-DEMAND, in-progress summary of the meeting SO FAR. The live transcript
 * text only exists on the client (the realtime captions; the server's
 * `live-turns.json` stores spans with empty text), so the client sends the
 * finalized caption lines it already holds and this tool runs the SAME
 * map-reduce summarizer the post-meeting job uses — no transcript.json needed.
 *
 * Nothing is persisted: the result is returned straight to the caller for the
 * live "Summary" panel (the UI refreshes it every ~10 minutes). The final,
 * stored summary is still produced once, by `meeting_process`/`meeting_summarize`
 * from the authoritative transcript, after the meeting ends.
 *
 * Mirrors `translate-tool.ts` for authz + per-meeting rate limiting: any
 * verified member of the room whose meeting this is may call it; every meeting
 * caption line is fenced as DATA by the summarizer's own prompt guards (RT-12).
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { chunkTranscript } from '../summary/chunker.js';
import { summarizeTranscript } from '../summary/summarizer.js';
import type { SummaryLanguage } from '../summary/prompts.js';
import { asLanguageCode } from '../../shared/languages.js';
import type { Segment } from '../transcript/segment-builder.js';
import type { AppTool, ToolRuntime } from './registry.js';
import { checkRateLimit } from './rate-limiter.js';

/** Auto-refresh cadence is ~10 min; this ceiling only guards a runaway client while still allowing a manual "refresh now". */
const LIVE_SUMMARY_LIMIT_PER_5MIN = 6;
/** Hard cap on lines accepted per call — a full-day meeting is well under this; beyond it the payload is abusive, not real. */
const MAX_SEGMENTS = 8_000;

interface InputSegment {
  speakerId: string;
  speakerName: string;
  startSec: number;
  text: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asLanguage(value: unknown): SummaryLanguage {
  return asLanguageCode(value);
}

/** One client caption line -> a summarizer input line, or null when it carries no usable text. */
function asInputSegment(value: unknown, index: number): InputSegment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const speakerName = asString(raw.speakerName);
  const speakerId = asString(raw.speakerId) || speakerName || 'unknown';
  const startSec = typeof raw.startSec === 'number' && Number.isFinite(raw.startSec) ? Math.max(0, raw.startSec) : index;
  return { speakerId, speakerName: speakerName || speakerId, startSec, text };
}

export const liveSummaryTool: AppTool = {
  name: 'meeting_live_summary',
  title: 'Tóm tắt nhanh khi đang họp',
  description: 'Tóm tắt phần cuộc họp đã diễn ra từ phụ đề trực tiếp, không cần transcript đã lưu — dùng cho bảng tóm tắt cập nhật mỗi ~10 phút.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'segments'],
    properties: {
      roomId: { type: 'string' },
      meetingId: { type: 'string' },
      title: { type: 'string' },
      language: { type: 'string' },
      segments: { type: 'array', items: { type: 'object' } },
    },
  },
  async execute(args, context, runtime: ToolRuntime) {
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId và meetingId là bắt buộc.');

    const actor = context.actor;
    if (!actor || actor.roomId !== roomId) {
      throw new AppError('Yêu cầu không hợp lệ cho phòng này.');
    }

    const rawSegments = Array.isArray(args.segments) ? args.segments : [];
    if (rawSegments.length === 0) throw new AppError('Chưa có nội dung phụ đề để tóm tắt.');
    if (rawSegments.length > MAX_SEGMENTS) throw new AppError('Quá nhiều dòng phụ đề trong một lượt tóm tắt.');

    const db = new AppDbBotClient(roomId);
    const meeting = await db.getById('meetings', 'room', meetingId);
    if (!meeting || meeting.roomId !== roomId) {
      throw new AppError('Không tìm thấy cuộc họp trong phòng này.');
    }

    if (!checkRateLimit('meeting_live_summary', meetingId, LIVE_SUMMARY_LIMIT_PER_5MIN, 5 * 60_000)) {
      throw new AppError('Tóm tắt trực tiếp đang bị giới hạn tần suất cho cuộc họp này. Vui lòng thử lại sau.');
    }

    const lines = rawSegments
      .map((value, index) => asInputSegment(value, index))
      .filter((s): s is InputSegment => s !== null)
      .sort((a, b) => a.startSec - b.startSec);
    if (lines.length === 0) throw new AppError('Chưa có nội dung phụ đề để tóm tắt.');

    // Build the Segment[] + names map the shared chunker/summarizer expect. endSec
    // is the next line's start (last line: its own start) — only used for the
    // chunk timestamp labels, never for audio math here.
    const names: Record<string, string> = {};
    const segments: Segment[] = lines.map((line, i) => {
      names[line.speakerId] = line.speakerName;
      return {
        id: `live-${i}`,
        speakerId: line.speakerId,
        startSec: line.startSec,
        endSec: lines[i + 1]?.startSec ?? line.startSec,
        text: line.text,
        lang: 'und',
        tokenCount: 0,
      };
    });

    const language = asLanguage(args.language);
    const title = asString(args.title);
    const speakerNames = [...new Set(Object.values(names))];
    const chunks = chunkTranscript(segments, names);

    const payload = await summarizeTranscript(runtime.agentBotHub, {
      roomId,
      chunks,
      language,
      title,
      speakerNames,
    });

    return {
      summary: payload.summary,
      decisions: payload.decisions,
      action_items: payload.action_items,
      key_topics: payload.key_topics,
    };
  },
};
