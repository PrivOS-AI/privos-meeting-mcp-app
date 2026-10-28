/**
 * `meeting_ask` — answer a question about one meeting from its transcript,
 * with citations to the lines that support it. During the meeting the client
 * sends the caption lines it holds (like `meeting_live_summary`); afterwards
 * the stored `transcript.json` is read. Nothing is stored: the answer comes
 * back with a short-lived `saveToken`.
 *
 * `meeting_save_answer` — appends that exact answer to the meeting's `qa.md`
 * in Files, which everyone in the room can read. It only accepts an answer
 * this server produced for this person and meeting (the token binds the
 * hash), so the file never holds text presented as an AI answer that the AI
 * did not give; saving the same answer twice adds it once.
 */
import { text as streamToText } from 'node:stream/consumers';

import { AppError } from '../../shared/app-error.js';
import { asLanguageCode } from '../../shared/languages.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { generateAsyncWithHubAi } from '../hub/hub-ai-client.js';
import { uploadBotFile } from '../files/hub-file-upload.js';
import { fetchFileReadable, listRoomFolderFiles } from '../media/hub-file-download.js';
import {
  answerHash,
  buildAskPrompt,
  issueSaveToken,
  newQaFile,
  parseAskReply,
  QA_FILE_NAME,
  QA_SYSTEM_CONTEXT,
  qaMarker,
  renderQaEntry,
  selectContext,
  verifySaveToken,
  type QaAnswer,
  type QaLine,
} from '../qa/meeting-qa.js';
import { loadStoredTranscript } from '../transcript/stored-transcript.js';
import { requireRoomMeeting, requireVerifiedActor } from './authz.js';
import { checkRateLimit } from './rate-limiter.js';
import type { AppTool, ToolRuntime } from './registry.js';
import { DISPLAY_NAME, ID, LANGUAGE, MAX_LINE_CHARS, ROOM_AND_MEETING, TEXT_LINE } from './schema-parts.js';

const MAX_QUESTION_CHARS = 500;
const MAX_LIVE_LINES = 8_000;
const ASK_LIMIT_PER_5MIN = 15;

const QUESTION = { type: 'string', minLength: 1, maxLength: MAX_QUESTION_CHARS } as const;
const CITATION = {
  type: 'object',
  required: ['lineId', 'atSec', 'speaker', 'quote'],
  properties: { lineId: ID, atSec: { type: 'number', minimum: 0 }, speaker: { type: 'string', maxLength: 200 }, quote: { type: 'string', maxLength: 400 } },
} as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The client's live caption lines -> numbered QA lines. */
function liveLines(raw: unknown[]): QaLine[] {
  const lines: QaLine[] = [];
  raw.forEach((value) => {
    if (!value || typeof value !== 'object') return;
    const r = value as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim().slice(0, MAX_LINE_CHARS) : '';
    if (!text) return;
    const atSec = typeof r.startSec === 'number' && Number.isFinite(r.startSec) ? Math.max(0, r.startSec) : 0;
    lines.push({ id: `L${lines.length + 1}`, atSec, speaker: asString(r.speakerName) || asString(r.speakerId) || '?', text });
  });
  return lines.sort((a, b) => a.atSec - b.atSec).map((line, i) => ({ ...line, id: `L${i + 1}` }));
}

async function askHubAi(runtime: ToolRuntime, roomId: string, prompt: string, sent: QaLine[]): Promise<QaAnswer> {
  const first = await generateAsyncWithHubAi(runtime.agentBotHub, { roomId, prompt, systemContext: QA_SYSTEM_CONTEXT });
  const parsed = parseAskReply(first.text, sent);
  if (parsed) return parsed;
  const retry = await generateAsyncWithHubAi(runtime.agentBotHub, {
    roomId,
    prompt: `${prompt}\n\nYour previous reply was not the JSON object asked for. Reply with ONLY that JSON object.`,
    systemContext: QA_SYSTEM_CONTEXT,
  });
  const second = parseAskReply(retry.text, sent);
  if (!second) throw new AppError('Hub AI did not return a usable answer. Please try again.', 'HUB_ERROR');
  return second;
}

export const askTool: AppTool = {
  name: 'meeting_ask',
  title: 'Ask about a meeting',
  description: 'Answer a question about one meeting from its transcript (or, while it runs, the captions so far), citing the lines that support the answer. Nothing is stored.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'question'],
    properties: {
      ...ROOM_AND_MEETING,
      question: QUESTION,
      language: LANGUAGE,
      segments: {
        type: 'array',
        maxItems: MAX_LIVE_LINES,
        description: 'While the meeting is running: the caption lines so far. Omit afterwards — the saved transcript is used.',
        items: { type: 'object', required: ['text'], properties: { speakerId: ID, speakerName: DISPLAY_NAME, startSec: { type: 'number', minimum: 0 }, text: TEXT_LINE } },
      },
    },
  },
  async execute(args, context, runtime: ToolRuntime) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    const question = asString(args.question).slice(0, MAX_QUESTION_CHARS);
    if (!roomId || !meetingId || !question) throw new AppError('roomId, meetingId and question are required.', 'INVALID_INPUT');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireRoomMeeting(db, actor, roomId, meetingId);
    if (!checkRateLimit('meeting_ask', actor.userId, ASK_LIMIT_PER_5MIN, 5 * 60_000)) {
      throw new AppError('Too many questions in a short time. Please wait a moment.', 'RATE_LIMITED');
    }

    const rawSegments = Array.isArray(args.segments) ? args.segments : [];
    if (rawSegments.length > MAX_LIVE_LINES) throw new AppError('Too many caption lines in one question.', 'INVALID_INPUT');
    let lines: QaLine[];
    const live = rawSegments.length > 0;
    if (live) {
      lines = liveLines(rawSegments);
    } else {
      const { doc, displayNameBySpeaker } = await loadStoredTranscript(db, runtime.agentBotHub, meeting);
      lines = doc.segments.map((s, i) => ({ id: `L${i + 1}`, atSec: s.startSec, speaker: displayNameBySpeaker[s.speakerId] ?? s.speakerId, text: s.text }));
    }
    if (lines.length === 0) throw new AppError('There is nothing in this meeting to answer from yet.', 'INVALID_STATE');

    const sent = selectContext(lines, question);
    const title = typeof meeting.title === 'string' ? meeting.title : '';
    const prompt = buildAskPrompt({ title, question, language: asLanguageCode(args.language), lines: sent, live });
    const answer = await askHubAi(runtime, roomId, prompt, sent);
    const saveToken = issueSaveToken({ userId: actor.userId, roomId, meetingId, hash: answerHash(question, answer) });
    return { ...answer, saveToken };
  },
};

/** One save at a time per meeting, so two saves never both read the old `qa.md` and one overwrite the other. */
const saving = new Map<string, Promise<unknown>>();

function asAnswer(value: unknown): QaAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.answer !== 'string' || !Array.isArray(r.citations)) return null;
  const citations = r.citations.flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const x = c as Record<string, unknown>;
    return typeof x.lineId === 'string' && typeof x.atSec === 'number' && typeof x.speaker === 'string' && typeof x.quote === 'string'
      ? [{ lineId: x.lineId, atSec: x.atSec, speaker: x.speaker, quote: x.quote }]
      : [];
  });
  return { answer: r.answer, citations, insufficient: r.insufficient === true };
}

export const saveAnswerTool: AppTool = {
  name: 'meeting_save_answer',
  title: 'Save an answer to Files',
  description: "Append an answer from meeting_ask (unchanged, with its saveToken) to the meeting's qa.md in the room's Files, readable by everyone in the room. Saving the same answer twice adds it once.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'question', 'answer', 'saveToken'],
    properties: {
      ...ROOM_AND_MEETING,
      question: QUESTION,
      answer: {
        type: 'object',
        required: ['answer', 'citations'],
        properties: { answer: { type: 'string', maxLength: 4000 }, insufficient: { type: 'boolean' }, citations: { type: 'array', maxItems: 5, items: CITATION } },
      },
      saveToken: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
  async execute(args, context, runtime: ToolRuntime) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    const question = asString(args.question).slice(0, MAX_QUESTION_CHARS);
    const answer = asAnswer(args.answer);
    const token = asString(args.saveToken);
    if (!roomId || !meetingId || !question || !answer || !token) throw new AppError('Invalid answer to save.', 'INVALID_INPUT');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireRoomMeeting(db, actor, roomId, meetingId);
    const hash = answerHash(question, answer);
    if (!verifySaveToken(token, { userId: actor.userId, roomId, meetingId, hash })) {
      throw new AppError('This answer can no longer be saved (it changed, expired, or was asked by someone else). Ask again, then save.', 'INVALID_INPUT');
    }
    const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
    if (!folderId) throw new AppError('Meeting has no Files folder yet.', 'INVALID_STATE');

    const previous = saving.get(meetingId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const hub = runtime.agentBotHub;
      const existing = (await listRoomFolderFiles(hub, roomId, folderId)).find((f) => f.name === QA_FILE_NAME);
      const current = existing ? await streamToText(await fetchFileReadable(hub, existing._id)) : newQaFile(typeof meeting.title === 'string' ? meeting.title : '');
      if (current.includes(qaMarker(hash))) return { saved: false, alreadySaved: true, fileName: QA_FILE_NAME };
      const next = `${current.replace(/\s*$/, '\n\n')}${renderQaEntry({ question, answer, hash, askedAtIso: new Date().toISOString() })}`;
      await uploadBotFile({ hub, roomId, folderId, fileName: QA_FILE_NAME, mimeType: 'text/markdown', data: Buffer.from(next, 'utf8'), duplicateAction: 'replace' });
      return { saved: true, alreadySaved: false, fileName: QA_FILE_NAME };
    });
    saving.set(meetingId, run);
    try {
      return await run;
    } finally {
      if (saving.get(meetingId) === run) saving.delete(meetingId);
    }
  },
};
