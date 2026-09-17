/**
 * A plain, user-facing application error. Thrown by tools and backend helpers
 * with a message safe to surface to the iframe (Vietnamese, no internals, no
 * credentials). Distinguished from unexpected errors only by type, so callers
 * can decide whether to show the message verbatim.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}
