/**
 * Tells the room's AI Chat what the user is looking at in the app
 * (`host/chatContext.set`), so a question to the Hub's assistant comes with
 * the meeting it is about. Reset to the default when the screen goes away. A
 * host without the method ignores it.
 */
import { useEffect } from 'react';

/** The host caps nothing documented; a short, useful context is the polite size. */
const MAX_CONTEXT_CHARS = 1_500;
let nextId = 9_000_000;

function setChatContext(context: string): void {
  try {
    window.parent.postMessage({ jsonrpc: '2.0', id: nextId++, method: 'host/chatContext.set', params: { context: context.slice(0, MAX_CONTEXT_CHARS) } }, '*');
  } catch {
    // Not in a host frame (tests, standalone): nothing to tell.
  }
}

/** `context === null` leaves the host's default in place. */
export function useAiChatContext(context: string | null): void {
  useEffect(() => {
    if (context === null) return;
    setChatContext(context);
    return () => setChatContext('');
  }, [context]);
}
