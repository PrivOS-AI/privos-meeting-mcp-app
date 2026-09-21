/**
 * Proactively push this app's bot key to the PrivOS Sandbox on startup.
 *
 * Hub AI (`sandbox:generate`, used by summarize/translate) runs in a per-tenant
 * sandbox VM that is only ESTABLISHED by a bot-key push (the push fires the VM
 * warmup). If the key was never pushed, `generate` fails with "Container
 * unavailable / no such image" — which is exactly the summary/translate error
 * seen before. So on init we check the key status and push when it is missing
 * and the current user is allowed to push.
 *
 * Runs as the CURRENT USER via `app.rest` (the push is gated by edit-room + bot
 * ownership/edit-bot), best-effort: any failure is logged, never blocks the app.
 * Both routes must be in the Hub's MCP REST allowlist
 * (`agents.sandbox.botKeyStatus`, `agents.sandbox.pushBotKey`).
 */
import type { McpApp } from '@privos_ai/app-react';

import { unwrapRestBody } from './rest-body.js';

interface BotKeyStatus {
  pushed?: boolean;
  hasBot?: boolean;
  hasSandbox?: boolean;
  canPush?: boolean;
  status?: 'success' | 'failed' | 'drift';
  needsForceOverwrite?: boolean;
}

/** Ensures the sandbox bot key is pushed so Hub AI works. Returns what it did, for logging. */
export async function ensureSandboxBotKey(app: McpApp, roomId: string): Promise<'pushed' | 'already' | 'cannot' | 'skipped'> {
  let status: BotKeyStatus;
  try {
    const raw = await app.rest({ method: 'GET', path: 'agents.sandbox.botKeyStatus', query: { roomId } });
    status = (unwrapRestBody(raw) ?? {}) as BotKeyStatus;
  } catch (error) {
    console.warn('[sandbox-bot-key] status check failed (Hub AI may be unavailable until the key is pushed):', error);
    return 'skipped';
  }

  // Already provisioned and healthy — nothing to do (a `drift` status still needs a re-push).
  if (status.pushed && status.status !== 'drift') return 'already';
  if (!status.canPush) {
    console.warn('[sandbox-bot-key] bot key not pushed and the current user cannot push it (needs edit-room + bot rights).');
    return 'cannot';
  }

  try {
    await app.rest({
      method: 'POST',
      path: 'agents.sandbox.pushBotKey',
      body: { roomId, bootstrapPush: true, ...(status.needsForceOverwrite ? { forceOverwritePersona: true } : {}) },
    });
    console.info('[sandbox-bot-key] pushed bot key to the sandbox (Hub AI warmup triggered).');
    return 'pushed';
  } catch (error) {
    console.warn('[sandbox-bot-key] push failed:', error);
    return 'skipped';
  }
}
