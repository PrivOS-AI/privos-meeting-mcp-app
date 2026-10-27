import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { filesFolderPath, openInFiles } from './open-in-files.js';

describe('filesFolderPath', () => {
  it('routes by room type to the files tab with the folder as context', () => {
    expect(filesFolderPath({ id: 'r1', type: 'p', name: 'team-a' }, 'f1')).toBe('/group/team-a/files/f1');
    expect(filesFolderPath({ id: 'r1', type: 'c', name: 'general' }, 'f1')).toBe('/channel/general/files/f1');
    expect(filesFolderPath({ id: 'r1', type: 'd', name: 'x' }, 'f1')).toBe('/direct/r1/files/f1');
  });

  it('defaults to a private group and needs a room name', () => {
    expect(filesFolderPath({ id: 'r1', name: 'team a' }, 'f/1')).toBe('/group/team%20a/files/f%2F1');
    expect(filesFolderPath({ id: 'r1' }, 'f1')).toBeNull();
  });
});

describe('openInFiles', () => {
  const posted: unknown[] = [];
  vi.stubGlobal('window', { parent: { postMessage: (message: unknown) => posted.push(message) } });
  afterEach(() => void posted.splice(0));

  it('asks the host to open the folder (the sandbox blocks window.open)', async () => {
    const app = { rest: async () => ({ room: { t: 'p', name: 'team-a' } }) } as unknown as McpApp;
    expect(await openInFiles(app, { id: 'r1', name: 'Team A' }, 'f1')).toBe(true);
    expect(posted).toEqual([{ jsonrpc: '2.0', method: 'OPEN_LINK', params: { url: '/group/team-a/files/f1' } }]);
  });

  it('falls back to the host room name when rooms.info is not granted', async () => {
    const app = { rest: async () => Promise.reject(new Error('Insufficient scope')) } as unknown as McpApp;
    expect(await openInFiles(app, { id: 'r1', name: 'team-a' }, 'f1')).toBe(true);
    expect(posted).toEqual([{ jsonrpc: '2.0', method: 'OPEN_LINK', params: { url: '/group/team-a/files/f1' } }]);
  });
});
