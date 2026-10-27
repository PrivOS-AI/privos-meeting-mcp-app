/**
 * `meeting_send_to_chat {roomId, meetingId}` — posts the ALREADY-SAVED
 * summary to the room's chat as the installation bot. The client never sends
 * `text`: the message is built server-side from `meetings.summaryText`
 * (already Hub AI's own output, already past the prompt-injection guards
 * that produced it) so a caller cannot smuggle arbitrary chat content
 * through this tool.
 *
 * OPEN QUESTION (plan.md risk table, spike P1-6 unresolved offline): the
 * exact `mcpapp.bot.*` tool name for posting a room message has never been
 * observed against a live Hub. `BOT_SEND_MESSAGE_TOOL` below is this phase's
 * DEFAULT — the name itself matches the Hub's registered tool list, the argument
 * shape is still unobserved. A failure HERE is not
 * swallowed — `callAppPlatformTool` throws an `AppError` with the Hub's own
 * message, which the UI is expected to use to disable the "Send to Chat"
 * button with a tooltip (plan.md: "no silent failure").
 *
 * Idempotent per meeting: once `sentToChatAt` is stamped a repeat call (retry,
 * double click, a second tab) returns that stamp without posting again, and
 * concurrent calls in this process share one send.
 */
import { AppError } from '../../shared/app-error.js';
import { folderName } from '../../shared/meeting-slug.js';
import { AppDbBotClient, type DbRow } from '../hub/app-db-bot-client.js';
import { callAppPlatformTool } from '../hub/bot-tool-call.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import { escapeMarkdown } from '../summary/sanitize.js';
import { upsertMeeting } from '../jobs/meeting-repository.js';
import type { AppTool } from './registry.js';
import { ROOM_AND_MEETING } from './schema-parts.js';

const BOT_SEND_MESSAGE_TOOL = 'mcpapp.bot.sendMessage';
const SEND_MESSAGE_SCOPE = 'bot:message:send';
const MAX_CHAT_CHARS = 1_500;

/** In-flight sends by meeting (single replica): a concurrent call awaits the same send instead of posting twice. */
const inFlight = new Map<string, Promise<{ sent: boolean; sentAt: string }>>();

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Truncates on a whitespace boundary when possible, so the message never ends mid-word. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** The meeting's start (its Files folder is named after that UTC day), or now when the row lacks a valid one. */
function startedAtDate(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** Server-built chat message — summary text is Hub AI's own output (already safe), the title is escaped defensively since it is raw user input. */
function buildChatSummary(meeting: DbRow, fileLink: string | undefined): string {
  const title = escapeMarkdown(typeof meeting.title === 'string' && meeting.title ? meeting.title : 'Meeting');
  const summary = typeof meeting.summaryText === 'string' ? meeting.summaryText : '';
  const header = `**Summary: ${title}**\n\n`;
  const footer = fileLink ? `\n\n📄 ${fileLink}` : '';
  const bodyBudget = Math.max(0, MAX_CHAT_CHARS - header.length - footer.length);
  return `${header}${truncate(summary, bodyBudget)}${footer}`;
}

export const sendToChatTool: AppTool = {
  name: 'meeting_send_to_chat',
  title: 'Send summary to chat',
  description: 'Send the saved meeting summary to the room chat via the installation bot — the content is built server-side, never taken from the client.',
  inputSchema: { type: 'object', required: ['roomId', 'meetingId'], properties: { ...ROOM_AND_MEETING } },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.', 'INVALID_INPUT');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
    if (typeof meeting.sentToChatAt === 'string' && meeting.sentToChatAt) {
      return { sent: false, alreadySent: true, sentAt: meeting.sentToChatAt };
    }
    const pending = inFlight.get(meetingId);
    if (pending) return { ...(await pending), sent: false, alreadySent: true };
    if (!meeting.summaryText || typeof meeting.summaryText !== 'string') {
      throw new AppError('Meeting has no summary to send yet.', 'INVALID_STATE');
    }

    // The Hub renders `@Files:<roomId>/<path>` as a link into the room's Files (its own chat syntax).
    const fileLink =
      typeof meeting.summaryFileId === 'string' && meeting.summaryFileId
        ? `@Files:${roomId}/${folderName(String(meeting.title ?? ''), meetingId, startedAtDate(meeting.startedAt))}/summary.md`
        : undefined;
    const text = buildChatSummary(meeting, fileLink);

    // Never swallowed: a Hub rejection (unknown tool, missing scope, bot not in room) surfaces verbatim so the UI
    // can show the "Send to chat unavailable" tooltip instead of silently no-op'ing (plan.md: "no silent failure").
    const send = (async () => {
      await callAppPlatformTool(BOT_SEND_MESSAGE_TOOL, { roomId, text }, SEND_MESSAGE_SCOPE, roomId);
      const sentAt = new Date().toISOString();
      await upsertMeeting(db, meetingId, { sentToChatAt: sentAt });
      return { sent: true, sentAt };
    })();
    inFlight.set(meetingId, send);
    try {
      return await send;
    } finally {
      inFlight.delete(meetingId);
    }
  },
};
