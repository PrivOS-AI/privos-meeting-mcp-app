/**
 * Resolves a Files record to something the iframe (opaque origin, no auth) can
 * use directly — a URL for `<audio src>`, or the parsed bytes for a JSON/text
 * artifact.
 *
 * REALITY (verified against the proven bot client in
 * `src/server/media/hub-file-download.ts`, not phase-07's unrun spike-03):
 *  - `GET file-management.files/:id` returns the file record FLAT
 *    (`{_id, name, channel_id, …, success}`) — NOT wrapped in `file`, and with
 *    NO presigned `downloadUrl` in the shapes observed so far.
 *  - `GET file-management.files/:id/download` streams the raw BYTES.
 *  - `app.rest()` returns a PARSED body (`RestResponse.body`): fine for a JSON
 *    artifact (the bridge hands back the object), but it cannot carry binary
 *    audio bytes.
 *
 * So: a JSON/text artifact is read straight from the parsed `/download` body
 * (see {@link downloadFileParsed}); audio needs a real URL, taken from whatever
 * URL field the metadata actually exposes. When neither works the thrown error
 * surfaces the real metadata keys + download body type so the live-Hub scheme
 * can be pinned down from the app's own error banner.
 */
import type { McpApp } from '@privos_ai/app-react';

export interface ResolvedFileUrl {
  url: string;
  /** True when `url` is an `ObjectURL` the caller must `URL.revokeObjectURL()` when done (blob path only). */
  isBlobUrl: boolean;
}

/** Metadata URL fields tried in order — presigned/public links the iframe can hit without auth. */
const URL_FIELDS = ['downloadUrl', 'url', 'link', 'publicUrl', 'presignedUrl', 'signedUrl', 'path'] as const;

function base64ToBlob(base64: string, mimeType: string): Blob {
  const cleaned = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function unwrap<T>(response: unknown): T {
  return ((response as { body?: T })?.body ?? response) as T;
}

/** The Hub returns the record either flat or wrapped in `file` — read both. */
function fileRecord(meta: unknown): Record<string, unknown> {
  const root = (meta ?? {}) as Record<string, unknown>;
  const nested = root.file;
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : root;
}

function firstUrl(record: Record<string, unknown>): string | undefined {
  for (const field of URL_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  return undefined;
}

/** GET the file's metadata record (flat or wrapped), for URL discovery + diagnostics. */
async function fetchFileMeta(app: McpApp, fileId: string): Promise<Record<string, unknown>> {
  return fileRecord(unwrap(await app.rest({ method: 'GET', path: `file-management.files/${fileId}` })));
}

/**
 * The parsed body of `GET file-management.files/:id/download`. For a JSON
 * artifact `app.rest()` already returns the object; a text artifact may come
 * back as a string. Callers that need structured data (transcript.json) use
 * this instead of a URL — no auth, no CSP media/connect origin needed.
 */
export async function downloadFileParsed<T = unknown>(app: McpApp, fileId: string): Promise<T> {
  return unwrap<T>(await app.rest({ method: 'GET', path: `file-management.files/${fileId}/download` }));
}

/** Resolves a Files id to a URL the browser can use directly (audio, images) — presigned when the metadata exposes one, a Blob URL when `/download` hands back encodable bytes. */
export async function resolveFileUrl(app: McpApp, fileId: string, fallbackMimeType = 'application/octet-stream'): Promise<ResolvedFileUrl> {
  const meta = await fetchFileMeta(app, fileId);
  const presigned = firstUrl(meta);
  if (presigned) return { url: presigned, isBlobUrl: false };

  // No usable URL in the metadata — try to turn the `/download` body into a Blob.
  const downloaded = await downloadFileParsed<unknown>(app, fileId);
  const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : fallbackMimeType;
  if (typeof downloaded === 'string') return { url: URL.createObjectURL(base64ToBlob(downloaded, mimeType)), isBlobUrl: true };

  // Binary that `app.rest()` could not carry, and no URL field matched. Surface
  // the REAL metadata so the live-Hub URL scheme can be finalized from the banner.
  const shape = `metaKeys=[${Object.keys(meta).join(',')}], downloadType=${downloaded === null ? 'null' : typeof downloaded}`;
  console.warn(`[file-download] no usable URL for ${fileId}; raw meta=`, meta);
  throw new Error(`Could not resolve a download URL for file ${fileId} — the Hub metadata exposed no fetchable URL and /download was not encodable (${shape}).`);
}
