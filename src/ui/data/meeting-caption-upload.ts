/**
 * Periodically persist the LIVE caption text to the meeting's Files folder
 * during recording. The realtime captions otherwise live only in the browser:
 * the audio parts are uploaded (and the post-meeting job re-derives a transcript
 * from them), but if the tab is closed mid-meeting the on-screen text is gone
 * until reprocessing. This writes a single, replace-in-place `captions-<id8>.json`
 * so the text up to the last push survives a crash and is available immediately.
 *
 * Best-effort and idempotent by file name; a failed push never blocks recording
 * or the audio-part upload it rides alongside.
 */
import type { McpApp } from '@privos_ai/app-react';

import { meetingId8 } from '../../shared/meeting-slug.js';

export interface CaptionExportLine {
  atSec: number;
  speakerKey?: string;
  speakerName?: string;
  text: string;
  translation?: string;
}

/** Own the file name to this meeting (like the audio parts) so two meetings sharing a folder never overwrite each other's captions. */
export function captionsFileName(meetingId: string): string {
  return `captions-${meetingId8(meetingId)}.json`;
}

/** UTF-8-safe base64 data URI (captions are frequently Vietnamese — `btoa` alone would throw on non-Latin1). */
function jsonToBase64DataUri(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:application/json;base64,${btoa(binary)}`;
}

export interface UploadCaptionsInput {
  roomId: string;
  folderId: string;
  meetingId: string;
  title: string;
  lines: readonly CaptionExportLine[];
}

export async function uploadLiveCaptions(app: McpApp, input: UploadCaptionsInput): Promise<void> {
  const payload = {
    meetingId: input.meetingId,
    title: input.title,
    updatedAt: new Date().toISOString(),
    lineCount: input.lines.length,
    lines: input.lines,
  };
  await app.uploadFile({
    channelId: input.roomId,
    folderId: input.folderId,
    fileName: captionsFileName(input.meetingId),
    base64Data: jsonToBase64DataUri(JSON.stringify(payload, null, 2)),
    mimeType: 'application/json',
    duplicateAction: 'replace',
  });
}
