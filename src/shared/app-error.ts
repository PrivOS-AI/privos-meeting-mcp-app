/**
 * A plain, user-facing application error. Thrown by tools and backend helpers
 * with a message safe to surface to the iframe (no internals, no credentials)
 * and a stable `code` the UI can branch on instead of matching message text.
 * `mcp-handler.ts` returns it as an `isError` tool result carrying
 * `structuredContent.error = { code, message, details }`; anything that is not
 * an AppError is left to the SDK, which hides its message (`-32603`).
 */
export type AppErrorCode =
  /** Generic, user-actionable failure with no more specific code. */
  | 'APP_ERROR'
  | 'INVALID_INPUT'
  | 'ROOM_MISMATCH'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NOT_MEETING_OWNER'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'CAPACITY_REACHED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_UNAVAILABLE'
  /** The installation bot is not a member of the room — fix: add it (`mcpapp.bot.joinCurrentRoom`). */
  | 'ASSISTANT_NOT_IN_ROOM'
  /** The admin has not granted the scope — fix: Admin > Apps. */
  | 'PERMISSION_NOT_GRANTED'
  | 'HUB_ERROR';

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: AppErrorCode = 'APP_ERROR',
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** The `{ code, message, details }` an `isError` tool result carries, or null for any other value. */
export function readToolError(raw: unknown): { code: AppErrorCode; message: string; details?: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object') return null;
  const error = (raw as { structuredContent?: { error?: unknown } }).structuredContent?.error;
  if (!error || typeof error !== 'object') return null;
  const { code, message, details } = error as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code: code as AppErrorCode, message, ...(details && typeof details === 'object' ? { details: details as Record<string, unknown> } : {}) };
}
