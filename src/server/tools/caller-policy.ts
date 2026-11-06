/**
 * Who besides a person may call a tool, checked once in `mcp-handler.ts`
 * before any tool runs (platform guide 2026-11-03, section 3). Deny by default:
 *
 *  - another app's server (`actor.callerApp`) only when its id is listed in
 *    `ALLOWED_CALLER_APPS` (empty by default: no app may call this one), and
 *    never from outside the room (`actor.crossRoom`): its bot cannot see the
 *    room, and this app keeps no per-room list of rooms an app may write to;
 *  - automation (`principalType === 'bot'`, an agent or another app) only the
 *    tools the manifest declares `shared` in `toolAccess`. Every other tool —
 *    credentials, tokens, audio/chunk ingest, settings, voiceprint edits and
 *    deletes — stays for people and this app's own server;
 *  - for automation the room is always the signed `actor.roomId`, never the
 *    tool's `roomId` argument: a different one is refused, a missing one is
 *    filled in, so every tool's own room checks run against the signed room.
 *
 * Each refusal has its own code (`CALLER_NOT_ALLOWED`, `CROSS_ROOM_NOT_ALLOWED`,
 * `ROOM_MISMATCH`) and one log line (`[caller-policy] refused <code> room=…
 * callerApp=… ptype=… tool=…`), so a caller refused by mistake shows on the
 * operator's log. Ids only: never an argument value or a token.
 *
 * `principalType` is absent on App Cluster dispatch (its assertion carries no
 * principal type), so those calls fall through to each tool's own checks
 * (meeting owner, room match), which a bot passes only for its own meetings.
 */
import type { VerifiedActor } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import { manifest } from '../manifest.js';

/** The tools the manifest shares with agents and other apps. */
export const SHARED_TOOLS: ReadonlySet<string> = new Set(
  Object.entries((manifest as { toolAccess?: Record<string, string> }).toolAccess ?? {})
    .filter(([, mode]) => mode === 'shared')
    .map(([name]) => name),
);

export type CallerRefusalCode = 'CALLER_NOT_ALLOWED' | 'CROSS_ROOM_NOT_ALLOWED' | 'ROOM_MISMATCH';

/** A call the caller policy refused: already logged, and the tool never ran. */
export class CallerRefusedError extends AppError {
  constructor(message: string, code: CallerRefusalCode, details?: Readonly<Record<string, unknown>>) {
    super(message, code, details);
    this.name = 'CallerRefusedError';
  }
}

/** An agent or another app's server, as far as the signed actor tells. */
export function isAutomatedCaller(actor: VerifiedActor): boolean {
  return actor.principalType === 'bot' || Boolean(actor.callerApp);
}

/**
 * Throws unless `actor` may call `toolName`; returns the arguments the tool
 * runs with (for automation, `roomId` is the signed room).
 */
export function applyCallerPolicy(
  toolName: string,
  actor: VerifiedActor,
  args: Record<string, unknown>,
  allowedCallerApps: ReadonlySet<string> = env.allowedCallerApps,
): Record<string, unknown> {
  const refuse = (code: CallerRefusalCode, message: string, details?: Record<string, unknown>): never => {
    console.warn(`[caller-policy] refused ${code} room=${actor.roomId ?? '-'} callerApp=${actor.callerApp ?? '-'} ptype=${actor.principalType ?? '-'} tool=${toolName}`);
    throw new CallerRefusedError(message, code, details);
  };

  if (actor.callerApp) {
    if (!allowedCallerApps.has(actor.callerApp)) {
      refuse('CALLER_NOT_ALLOWED', 'This app does not accept calls from that app.', { callerApp: actor.callerApp });
    }
    if (actor.crossRoom) {
      refuse('CROSS_ROOM_NOT_ALLOWED', 'Calls from outside the room are not accepted.', { callerApp: actor.callerApp });
    }
  }
  if (!isAutomatedCaller(actor)) return args;

  if (!SHARED_TOOLS.has(toolName)) {
    refuse('CALLER_NOT_ALLOWED', `${toolName} is not available to agents or other apps.`);
  }
  if (!actor.roomId) refuse('ROOM_MISMATCH', 'Invalid request for this room.');
  if (args.roomId !== undefined && args.roomId !== actor.roomId) {
    refuse('ROOM_MISMATCH', 'Invalid request for this room.');
  }
  return { ...args, roomId: actor.roomId };
}
