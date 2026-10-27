/**
 * Shared JSON Schema fragments for tool `inputSchema`s. They bound every input
 * the Hub or a model can send; the tools still validate (and cap) everything
 * themselves, since a schema is advisory to the caller. `privos-app.json`'s
 * copy is written from these by `npm run manifest:sync-tools`.
 */
import { SUPPORTED_LANGUAGES } from '../../shared/languages.js';

/** Hub / App DB / Files ids and client-generated keys. */
export const ID = { type: 'string', minLength: 1, maxLength: 128 } as const;

/** A meeting-clock offset in milliseconds (a meeting is capped well below a day). */
export const MS = { type: 'number', minimum: 0, maximum: 86_400_000 } as const;

export const LANGUAGE = { type: 'string', enum: [...SUPPORTED_LANGUAGES] } as const;

/** A person's display name (`sanitizeDisplayName` caps it at the same length). */
export const DISPLAY_NAME = { type: 'string', maxLength: 80 } as const;

/** One caption line. */
export const MAX_LINE_CHARS = 2_000;
export const TEXT_LINE = { type: 'string', maxLength: MAX_LINE_CHARS } as const;

export const ROOM_AND_MEETING = { roomId: ID, meetingId: ID } as const;

export const NO_ARGUMENTS = { type: 'object', properties: {} } as const;
