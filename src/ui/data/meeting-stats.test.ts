import { describe, expect, it } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { loadMeetingStats, startOfWeekIso } from './meeting-stats.js';

function fakeApp(handlers: Record<string, (args: Record<string, unknown>) => unknown>): McpApp {
  return {
    callServerTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unhandled tool: ${name}`);
      return handler(args);
    },
  } as unknown as McpApp;
}

describe('startOfWeekIso', () => {
  it('resolves to the Monday of the given week (Wednesday input)', () => {
    const wednesday = new Date(2026, 8, 16); // 2026-09-16 is a Wednesday
    const monday = new Date(startOfWeekIso(wednesday));
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(14);
  });

  it('resolves to the same day when given a Monday', () => {
    const monday = new Date(2026, 8, 14);
    expect(new Date(startOfWeekIso(monday)).getDate()).toBe(14);
  });
});

describe('loadMeetingStats', () => {
  it('combines count + aggregate calls into the 4 stat fields', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const app = fakeApp({
      'mcpapp.db.count': (args) => {
        calls.push({ name: 'mcpapp.db.count', args });
        if (args.collection === 'meetings') return { count: 3 };
        if (args.collection === 'action_items') return { count: 5 };
        if (args.collection === 'bookmarks') return { count: 8 };
        return { count: 0 };
      },
      'mcpapp.db.aggregate': (args) => {
        calls.push({ name: 'mcpapp.db.aggregate', args });
        return { result: 7200 };
      },
    });

    const stats = await loadMeetingStats(app, 'room-1', new Date(2026, 8, 16));

    expect(stats).toEqual({ meetingsThisWeek: 3, totalDurationSec: 7200, openActionItems: 5, bookmarkCount: 8 });
    // Never pages full record sets — only count/aggregate tools are called.
    expect(calls.every((c) => c.name === 'mcpapp.db.count' || c.name === 'mcpapp.db.aggregate')).toBe(true);
  });

  it('defaults totalDurationSec to 0 when aggregate returns a grouped array instead of a number', async () => {
    const app = fakeApp({
      'mcpapp.db.count': () => ({ count: 0 }),
      'mcpapp.db.aggregate': () => ({ result: [{ _id: 'x', result: 5 }] }),
    });

    const stats = await loadMeetingStats(app, 'room-1');
    expect(stats.totalDurationSec).toBe(0);
  });
});
