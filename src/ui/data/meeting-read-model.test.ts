import { describe, expect, it } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { deleteMeeting, type MeetingReadModel } from './meeting-read-model.js';

interface RestReq {
  method?: string;
  path: string;
  query?: Record<string, unknown>;
}

/** Fake McpApp backing a single meeting folder; DELETE mutates its file set. */
function makeFakeApp(opts: { folderFiles?: string[]; failFileDelete?: boolean; failFolderDelete?: boolean } = {}) {
  const restCalls: RestReq[] = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let folderFiles = [...(opts.folderFiles ?? [])];

  const app = {
    async rest(req: RestReq) {
      restCalls.push(req);
      if (req.method === 'GET' && req.path.startsWith('file-management.files.channel/')) {
        return { files: folderFiles.map((id) => ({ _id: id })) };
      }
      if (req.method === 'DELETE' && req.path.startsWith('file-management.files/')) {
        if (opts.failFileDelete) throw new Error('forbidden');
        const id = req.path.slice('file-management.files/'.length);
        folderFiles = folderFiles.filter((f) => f !== id);
        return { success: true };
      }
      if (req.method === 'DELETE' && req.path.startsWith('file-management.folders/')) {
        if (opts.failFolderDelete) throw new Error('unsupported');
        return { success: true };
      }
      return {};
    },
    async callServerTool(req: { name: string; arguments: Record<string, unknown> }) {
      toolCalls.push(req);
      return null; // db.delete carries no envelope — passes straight through
    },
  } as unknown as McpApp;

  return { app, restCalls, toolCalls, remaining: () => folderFiles };
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
  it('removes every file in the folder (including untracked parts), the folder, then the db row', async () => {
    const fake = makeFakeApp({ folderFiles: ['f-audio', 'f-summary', 'audio.part-000', 'audio.part-001'] });
    await deleteMeeting(fake.app, meeting());

    expect(fake.remaining()).toEqual([]); // all folder files gone, parts included
    expect(fake.restCalls.some((c) => c.method === 'DELETE' && c.path === 'file-management.folders/fold-1')).toBe(true);
    const del = fake.toolCalls.find((c) => c.name === 'mcpapp.db.delete');
    expect(del?.arguments).toEqual({ collection: 'meetings', id: 'm-1' });
  });

  it('deletes the db row even when file deletes fail, and does not loop forever on undeletable files', async () => {
    const fake = makeFakeApp({ folderFiles: ['f-audio', 'f-x'], failFileDelete: true });
    await deleteMeeting(fake.app, meeting());

    // Progress guard: at most one listing pass beyond the first is tolerated.
    const listPasses = fake.restCalls.filter((c) => c.method === 'GET' && c.path.startsWith('file-management.files.channel/')).length;
    expect(listPasses).toBeLessThanOrEqual(2);
    expect(fake.toolCalls.some((c) => c.name === 'mcpapp.db.delete')).toBe(true);
  });

  it('still deletes the db row when the folder-delete endpoint is unsupported', async () => {
    const fake = makeFakeApp({ folderFiles: ['f-audio'], failFolderDelete: true });
    await deleteMeeting(fake.app, meeting());
    expect(fake.toolCalls.some((c) => c.name === 'mcpapp.db.delete')).toBe(true);
  });

  it('falls back to tracked file ids and skips folder ops when the meeting has no folderId', async () => {
    const fake = makeFakeApp();
    await deleteMeeting(fake.app, meeting({ folderId: undefined }));

    expect(fake.restCalls.some((c) => c.path.startsWith('file-management.files.channel/'))).toBe(false);
    expect(fake.restCalls.some((c) => c.path.startsWith('file-management.folders/'))).toBe(false);
    // Tracked artifacts are still deleted directly.
    expect(fake.restCalls.filter((c) => c.method === 'DELETE' && c.path.startsWith('file-management.files/')).map((c) => c.path)).toEqual(
      expect.arrayContaining(['file-management.files/f-audio', 'file-management.files/f-summary']),
    );
    expect(fake.toolCalls.some((c) => c.name === 'mcpapp.db.delete')).toBe(true);
  });
});
