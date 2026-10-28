/**
 * `meeting_notes_save` — the meeting owner's own notes, typed during or after
 * the meeting. Kept on the meeting row (the summary reads them as "what the
 * recorder found important") and written to `notes.md` in the meeting's Files
 * folder for people to read. Saves are whole-text with a client revision that
 * only goes up, so a slow save never overwrites a newer one.
 */
import { AppError } from '../../shared/app-error.js';
import { sanitizeDisplayName } from '../summary/sanitize.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { uploadBotFile } from '../files/hub-file-upload.js';
import { upsertMeeting } from '../jobs/meeting-repository.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import { checkRateLimit } from './rate-limiter.js';
import type { AppTool, ToolRuntime } from './registry.js';
import { ROOM_AND_MEETING } from './schema-parts.js';

export const MAX_NOTES_CHARS = 20_000;
export const NOTES_FILE_NAME = 'notes.md';
const SAVES_PER_MINUTE = 30;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const notesTool: AppTool = {
  name: 'meeting_notes_save',
  title: 'Save meeting notes',
  description: "Save the meeting owner's notes (whole text) to the meeting and to notes.md in its Files folder; the summary takes them into account.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'text', 'revision'],
    properties: {
      ...ROOM_AND_MEETING,
      text: { type: 'string', maxLength: MAX_NOTES_CHARS },
      revision: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
    },
  },
  async execute(args, context, runtime: ToolRuntime) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId).trim();
    const meetingId = asString(args.meetingId).trim();
    const text = asString(args.text).slice(0, MAX_NOTES_CHARS);
    const revision = Number(args.revision);
    if (!roomId || !meetingId || !Number.isInteger(revision) || revision < 1) throw new AppError('Invalid notes to save.', 'INVALID_INPUT');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
    if (!checkRateLimit('meeting_notes_save', meetingId, SAVES_PER_MINUTE, 60_000)) {
      throw new AppError('Notes are being saved too often. They will be saved shortly.', 'RATE_LIMITED');
    }
    const stored = typeof meeting.notesRevision === 'number' ? meeting.notesRevision : 0;
    if (revision <= stored) return { saved: false, stale: true, revision: stored };

    await upsertMeeting(db, meetingId, { notesText: text, notesRevision: revision });

    // The readable copy is best-effort: the notes are already safe on the meeting row.
    const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
    let fileSaved = false;
    if (folderId) {
      const title = sanitizeDisplayName(typeof meeting.title === 'string' ? meeting.title : '') || 'Meeting';
      await uploadBotFile({
        hub: runtime.agentBotHub,
        roomId,
        folderId,
        fileName: NOTES_FILE_NAME,
        mimeType: 'text/markdown',
        data: Buffer.from(`# Notes — ${title}\n\n${text.trim()}\n`, 'utf8'),
        duplicateAction: 'replace',
      })
        .then(() => (fileSaved = true))
        .catch((error: unknown) => console.warn('[meeting_notes_save] notes.md not written (notes kept on the meeting):', error instanceof Error ? error.message : error));
    }
    return { saved: true, stale: false, revision, fileSaved };
  },
};
