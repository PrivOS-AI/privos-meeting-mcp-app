import { describe, expect, it } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { deleteMeeting, type MeetingReadModel } from './meeting-read-model.js';

interface RestReq {
  method?: string;
  path: string;
  query?: Record<string, unknown>;
}

/** Fake McpApp recording REST + tool calls, with optional folder-delete failure. */
function makeFakeApp(opts: { failFolderDelete?: boolean } = {}) {
  const restCalls: RestReq[] = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  const app = {
    async rest(req: RestReq) {
      restCalls.push(req);
      if (req.method === 'DELETE' && req.path.startsWith('file-management.folders/')) {
        if (opts.failFolderDelete) throw new Error('forbidden');
        return { success: true };
      }
      return { success: true };
    },
    async callServerTool(req: { name: string; arguments: Record<string, unknown> }) {
      toolCalls.push(req);
      return null; // db.delete carries no envelope — passes straight through
    },
  } as unknown as McpApp;

  return { app, restCalls, toolCalls };
}

function meeting(over: Partial<MeetingReadModel> = {}): MeetingReadModel {
  return {
    _id: 'm-1',
    roomId: 'room-1',
    folderId: 'fold-1',
    audioFileId: 'f-audio',
    summaryFileId: 'f-summary',
    ...over,
  } as MeetingReadModel;
}

describe('deleteMeeting', () => {
  it('recursively deletes the meeting folder (one call), then the db row, and does not delete files individually', async () => {
    const fake = makeFakeApp();
    await deleteMeeting(fake.app, meeting());

    const folderDeletes = fake.restCalls.filter((c) => c.method === 'DELETE' && c.path === 'file-management.folders/fold-1');
    expect(folderDeletes).toHaveLength(1);
    expect(folderDeletes[0]?.query).toEqual({ recursive: 'true' });
    // The recursive folder delete covers all files — no per-file DELETE needed.
    expect(fake.restCalls.some((c) => c.path.startsWith('file-management.files/'))).toBe(false);
    const del = fake.toolCalls.find((c) => c.name === 'mcpapp.db.delete');
    expect(del?.arguments).toEqual({ collection: 'meetings', id: 'm-1' });
  });

  it('falls back to deleting tracked file ids when the folder delete fails, and still deletes the db row', async () => {
    const fake = makeFakeApp({ failFolderDelete: true });
    await deleteMeeting(fake.app, meeting());

    const fileDeletes = fake.restCalls.filter((c) => c.method === 'DELETE' && c.path.startsWith('file-management.files/')).map((c) => c.path);
    expect(fileDeletes).toEqual(expect.arrayContaining(['file-management.files/f-audio', 'file-management.files/f-summary']));
    expect(fake.toolCalls.some((c) => c.name === 'mcpapp.db.delete')).toBe(true);
  });

  it('deletes tracked file ids (no folder call) when the meeting has no folderId', async () => {
    const fake = makeFakeApp();
    await deleteMeeting(fake.app, meeting({ folderId: undefined }));

    expect(fake.restCalls.some((c) => c.path.startsWith('file-management.folders/'))).toBe(false);
    expect(fake.restCalls.filter((c) => c.method === 'DELETE' && c.path.startsWith('file-management.files/')).map((c) => c.path)).toEqual(
      expect.arrayContaining(['file-management.files/f-audio', 'file-management.files/f-summary']),
    );
    expect(fake.toolCalls.some((c) => c.name === 'mcpapp.db.delete')).toBe(true);
  });
});
