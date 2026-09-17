/**
 * Ensure this app's installation bot is a member of `roomId` so it can write to
 * the room's Files. Best-effort and idempotent: a bot that is already a member,
 * or a Hub that rejects the call, must not fail `meeting_bootstrap` — the app
 * degrades to "ask an admin to add the bot" (manifest degradedBehavior).
 *
 * NOTE: the exact `mcpapp.bot.*` surface + `bot:room:join` grant resolution is a
 * Phase-1 foundational spike (spike 6). Until observed against a live Hub this
 * uses the documented tool name and swallows any error, returning whether the
 * join is believed to have succeeded.
 */
import { callAppPlatformTool } from './bot-tool-call.js';

export async function ensureBotInRoom(roomId: string): Promise<boolean> {
  try {
    await callAppPlatformTool('mcpapp.bot.joinRoom', { roomId }, 'bot:room:join', roomId);
    return true;
  } catch {
    // Already a member, missing grant, or unverified surface — non-fatal.
    return false;
  }
}
