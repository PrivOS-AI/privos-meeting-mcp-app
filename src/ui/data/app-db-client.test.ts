import { describe, expect, it } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { AppDbClient } from './app-db-client.js';

type Args = Record<string, unknown>;

/** Fake McpApp whose `mcpapp.db.query` answers via `answer`; records every call's arguments. */
function fakeApp(answer: (args: Args) => unknown) {
  const calls: Args[] = [];
  const app = {
    async callServerTool({ arguments: args }: { name: string; arguments: Args }) {
      calls.push(args);
      return answer(args);
    },
  } as unknown as McpApp;
  return { app, calls };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `r${i}`, _createdAt: '', _updatedAt: '' }));

/** A Hub with paging over `all`, pages of `min(limit, 200)`; `total` stops at `cap`. */
function pagingAnswer(all: ReturnType<typeof rows>, cap = 10_000) {
  return (args: Args) => {
    const limit = Math.min(Number(args.limit ?? 50), 200);
    const offset = Number(args.offset ?? 0);
    const items = all.slice(offset, offset + limit);
    const hasMore = offset + items.length < all.length;
    return { items, pagination: { limit, offset, total: Math.min(all.length, cap), totalCapped: all.length > cap, hasMore, nextOffset: hasMore ? offset + items.length : null, nextCursor: null } };
  };
}

describe('AppDbClient.queryAll', () => {
  it('reads every page on a paging Hub', async () => {
    const { app, calls } = fakeApp(pagingAnswer(rows(430)));
    const records = await new AppDbClient(app).queryAll({ collection: 'action_items', where: [{ field: 'meeting', op: '==', value: 'm1' }] });
    expect(records).toHaveLength(430);
    expect(calls.map((c) => c.offset)).toEqual([0, 200, 400]);
    expect(calls[0]).toMatchObject({ collection: 'action_items', paginate: true, limit: 1000 });
  });

  it('reads the old { records, total } answer once on a Hub without paging', async () => {
    const { app, calls } = fakeApp(() => ({ records: rows(3), total: 3, totalCapped: false }));
    expect(await new AppDbClient(app).queryAll({ collection: 'bookmarks' })).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });
});

describe('AppDbClient.queryPage', () => {
  it('takes hasMore and a capped total from the paged envelope', async () => {
    const { app } = fakeApp(pagingAnswer(rows(10_050)));
    const page = await new AppDbClient(app).queryPage({ collection: 'meetings', limit: 50, offset: 10_000 });
    expect(page.records).toHaveLength(50);
    expect(page).toMatchObject({ total: 10_000, totalCapped: true, hasMore: false });
  });

  it('keeps "Load more" past a capped total on an older Hub (full page = more)', async () => {
    const { app } = fakeApp(() => ({ records: rows(50), total: 10_000, totalCapped: true }));
    const page = await new AppDbClient(app).queryPage({ collection: 'meetings', limit: 50, offset: 10_000 });
    expect(page).toMatchObject({ total: 10_000, totalCapped: true, hasMore: true });
  });

  it('derives hasMore from offset and total on an older Hub', async () => {
    const { app } = fakeApp(() => ({ records: rows(20), total: 70 }));
    const db = new AppDbClient(app);
    expect((await db.queryPage({ collection: 'meetings', limit: 50, offset: 50 })).hasMore).toBe(false);
    expect((await db.queryPage({ collection: 'meetings', limit: 50, offset: 0 })).hasMore).toBe(true);
  });

  it('reports a total the Hub did not count as null', async () => {
    const { app } = fakeApp(() => ({ items: rows(2), pagination: { limit: 50, offset: 0, total: null, hasMore: false, nextOffset: null, nextCursor: null } }));
    expect(await new AppDbClient(app).queryPage({ collection: 'meetings', limit: 50 })).toMatchObject({ total: null, totalCapped: false, hasMore: false });
  });
});
