/**
 * Reads the stable error code a server tool returns with an `isError` result
 * (`structuredContent.error`, see `mcp-handler.ts`). `parseToolResult` from the
 * SDK keeps only the message, so call sites that branch on the KIND of failure
 * (capacity, bot not in the room) parse through here instead.
 */
import { parseToolResult } from '@privos_ai/app-react';

import { readToolError, type AppErrorCode } from '../../shared/app-error.js';

export class ToolCallError extends Error {
  constructor(
    message: string,
    readonly code: AppErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

/** `parseToolResult`, but a tool error is thrown as a {@link ToolCallError} carrying its code. */
export function parseToolResultOrThrow(raw: unknown): Record<string, unknown> {
  const error = readToolError(raw);
  if (error) throw new ToolCallError(error.message, error.code, error.details);
  return parseToolResult(raw) as Record<string, unknown>;
}

export function toolErrorCode(error: unknown): AppErrorCode | undefined {
  return error instanceof ToolCallError ? error.code : undefined;
}
