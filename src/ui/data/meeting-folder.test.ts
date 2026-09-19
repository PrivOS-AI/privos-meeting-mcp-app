import { describe, expect, it, vi } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { ensureMeetingFolder } from './meeting-folder.js';

interface Folder {
  _id: string;
  name: string;
  father: string | null;
}

/** Fake Hub Files: `wrap` toggles the `{ statusCode, body }` wrapper vs the flat downstream body the real bridge returns. */
function fakeApp(folders: Folder[], wrap: boolean, opts: { raceOnCreate?: boolean } = {}) {
  const rest = vi.fn(async (params: { method: string; path: string; query?: Record<string, unknown>; body?: Record<string, unknown> }) => {
    const reply = (body: unknown) => (wrap ? { statusCode: 200, body } : body);
    if (params.method === 'GET') {
      const father = (params.query?.fatherId as string | undefined) ?? null;
      return reply({ folders: folders.filter((f) => f.father === father), success: true });
    }
    const father = (params.body?.fatherId as string | undefined) ?? null;
    const name = params.body?.name as string;
    if (opts.raceOnCreate || folders.some((f) => f.name === name && f.father === father)) {
      // Another writer got there first: the folder exists by the time we re-list.
      if (!folders.some((f) => f.name === name && f.father === father)) folders.push({ _id: `raced-${name}`, name, father });
      throw new Error('DUPLICATE_FOLDER');
    }
    const folder = { _id: `new-${name}`, name, father };
    folders.push(folder);
    return reply({ folder, success: true });
  });
  return { app: { rest } as unknown as McpApp, rest };
}

describe('ensureMeetingFolder', () => {
  it.each([false, true])('creates each missing segment and returns the deepest id (wrapped=%s)', async (wrap) => {
    const { app } = fakeApp([], wrap);
    expect(await ensureMeetingFolder(app, 'room-1', 'Meetings/2026-09-19 standup')).toBe('new-2026-09-19 standup');
  });

  it('reuses an existing folder instead of re-creating it (flat bridge body)', async () => {
    const { app, rest } = fakeApp([{ _id: 'meetings-id', name: 'Meetings', father: null }], false);
    expect(await ensureMeetingFolder(app, 'room-1', 'Meetings/standup')).toBe('new-standup');
    const creates = rest.mock.calls.filter(([p]) => p.method === 'POST').map(([p]) => p.body?.name);
    expect(creates).toEqual(['standup']);
  });

  it('recovers from a DUPLICATE_FOLDER create race by re-listing', async () => {
    const { app } = fakeApp([], false, { raceOnCreate: true });
    expect(await ensureMeetingFolder(app, 'room-1', 'Meetings')).toBe('raced-Meetings');
  });

  it('rethrows create failures that are not a duplicate', async () => {
    const rest = vi.fn(async (params: { method: string }) => {
      if (params.method === 'GET') return { folders: [] };
      throw new Error('App is not permitted to call POST /file-management.folders.create');
    });
    await expect(ensureMeetingFolder({ rest } as unknown as McpApp, 'room-1', 'Meetings')).rejects.toThrow(/not permitted/);
  });
});
