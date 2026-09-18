/**
 * Resolves a Files record to a URL the browser can `fetch()`/play directly,
 * from the iframe (user context) — phase-07 § Architecture.
 *
 * Preferred path: `GET file-management.files/:fileId` returns a presigned
 * `downloadUrl` the opaque-origin iframe can fetch without auth (the origin
 * is declared in the manifest's `connect-src`/`media-src` via
 * `PRIVOS_FILES_ORIGIN`). FALLBACK (plan default + comment — never exercised
 * in this static-only phase, no live Hub to observe its actual response
 * shape against): when `downloadUrl` is absent, pull bytes through
 * `app.rest()`'s authenticated `/download` proxy and turn whatever the
 * bridge hands back into a `Blob` URL.
 */
import type { McpApp } from '@privos_ai/app-react';

export interface ResolvedFileUrl {
  url: string;
  /** True when `url` is an `ObjectURL` the caller must `URL.revokeObjectURL()` when done (fallback path only). */
  isBlobUrl: boolean;
}

interface FileMetaEnvelope {
  file?: { downloadUrl?: string; mimeType?: string; name?: string };
}

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

/** Resolves a Files id to a URL the browser can use directly — presigned when available, a Blob URL otherwise. */
export async function resolveFileUrl(app: McpApp, fileId: string, fallbackMimeType = 'application/octet-stream'): Promise<ResolvedFileUrl> {
  const meta = unwrap<FileMetaEnvelope>(await app.rest({ method: 'GET', path: `file-management.files/${fileId}` }));
  if (meta.file?.downloadUrl) return { url: meta.file.downloadUrl, isBlobUrl: false };

  // Fallback: binary proxy download — see module header, this branch is defensive and untested against a live Hub.
  const downloaded = unwrap<unknown>(await app.rest({ method: 'GET', path: `file-management.files/${fileId}/download` }));
  if (typeof downloaded === 'string') {
    return { url: URL.createObjectURL(base64ToBlob(downloaded, meta.file?.mimeType ?? fallbackMimeType)), isBlobUrl: true };
  }
  throw new Error(`Không lấy được đường dẫn tải tệp ${fileId} (thiếu downloadUrl và fallback nhị phân không đúng định dạng mong đợi).`);
}
