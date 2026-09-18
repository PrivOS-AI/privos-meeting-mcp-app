import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../env.js';
import { sonioxAsyncProvider } from './soniox-async-provider.js';

describe('sonioxAsyncProvider.transcribeFile', () => {
  const originalKey = env.sonioxApiKey;
  let dir: string;
  let audioPath: string;

  beforeEach(async () => {
    env.sonioxApiKey = 'test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'soniox-test-'));
    audioPath = path.join(dir, 'audio.webm');
    await writeFile(audioPath, Buffer.from('fake-webm-bytes'));
  });

  afterEach(async () => {
    env.sonioxApiKey = originalKey;
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('throws a clear error when SONIOX_API_KEY is missing', async () => {
    env.sonioxApiKey = undefined;
    await expect(sonioxAsyncProvider.transcribeFile({ audioPath })).rejects.toThrow(/SONIOX_API_KEY/);
  });

  it('uploads, creates a transcription, polls to completed, maps tokens, and cleans up both remote objects', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith('/v1/files') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'file-1' }) } as Response;
      if (url.endsWith('/v1/transcriptions') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'trans-1' }) } as Response;
      if (url.endsWith('/v1/transcriptions/trans-1') && init?.method !== 'DELETE') {
        return { ok: true, json: async () => ({ status: 'completed' }) } as Response;
      }
      if (url.endsWith('/v1/transcriptions/trans-1/transcript')) {
        return { ok: true, json: async () => ({ language: 'vi', tokens: [{ text: 'hi', start_ms: 0, end_ms: 100, speaker: '1' }] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const providerIds: Array<{ providerFileId?: string; providerTranscriptionId?: string }> = [];
    const result = await sonioxAsyncProvider.transcribeFile({
      audioPath,
      onProviderIds: (ids) => {
        providerIds.push(ids);
      },
    });

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toMatchObject({ text: 'hi', startMs: 0, endMs: 100, speaker: '1' });
    expect(result.language).toBe('vi');
    expect(providerIds[0]).toEqual({ providerFileId: 'file-1' });
    expect(providerIds[1]).toEqual({ providerFileId: 'file-1', providerTranscriptionId: 'trans-1' });
    expect(calls.some((c) => c.url.endsWith('/v1/transcriptions/trans-1') && c.method === 'DELETE')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/v1/files/file-1') && c.method === 'DELETE')).toBe(true);
  });

  it('throws when the transcription reaches status "error"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/v1/files') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'file-1' }) } as Response;
        if (url.endsWith('/v1/transcriptions') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'trans-1' }) } as Response;
        if (url.endsWith('/v1/transcriptions/trans-1') && init?.method !== 'DELETE') {
          return { ok: true, json: async () => ({ status: 'error', error_message: 'boom' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );
    await expect(sonioxAsyncProvider.transcribeFile({ audioPath })).rejects.toThrow(/boom/);
  });

  it('still sends both DELETE cleanup calls when the poll is aborted mid-flight', async () => {
    const controller = new AbortController();
    const deletes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/v1/files') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'file-1' }) } as Response;
        if (url.endsWith('/v1/transcriptions') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'trans-1' }) } as Response;
        if (init?.method === 'DELETE') {
          deletes.push(url);
          return { ok: true, json: async () => ({}) } as Response;
        }
        if (url.endsWith('/v1/transcriptions/trans-1')) {
          controller.abort();
          return { ok: true, json: async () => ({ status: 'processing' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    await expect(sonioxAsyncProvider.transcribeFile({ audioPath, signal: controller.signal })).rejects.toThrow();
    expect(deletes.some((u) => u.endsWith('/v1/transcriptions/trans-1'))).toBe(true);
    expect(deletes.some((u) => u.endsWith('/v1/files/file-1'))).toBe(true);
  });

  it('resumes from resumeProviderTranscriptionId without re-uploading', async () => {
    const uploadCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/v1/files') && init?.method === 'POST') {
          uploadCalls.push(url);
          return { ok: true, json: async () => ({ id: 'new-file' }) } as Response;
        }
        if (url.endsWith('/v1/transcriptions/existing-trans') && init?.method !== 'DELETE') {
          return { ok: true, json: async () => ({ status: 'completed' }) } as Response;
        }
        if (url.endsWith('/v1/transcriptions/existing-trans/transcript')) {
          return { ok: true, json: async () => ({ tokens: [] }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );
    await sonioxAsyncProvider.transcribeFile({
      audioPath,
      resumeProviderTranscriptionId: 'existing-trans',
      resumeProviderFileId: 'existing-file',
    });
    expect(uploadCalls).toHaveLength(0);
  });
});
