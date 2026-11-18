import { describe, expect, it } from 'vitest';

import { pagedBody, readAllPages, type PagingArgs } from './list-pages.js';

const rowsOf = (body: unknown): string[] => (Array.isArray(body) ? body : ((body as { records?: string[] } | null)?.records ?? []));

/** A Hub with paging: `rows` served in pages of `min(limit, 200)`. */
function pagingHub(rows: string[]) {
  const calls: PagingArgs[] = [];
  const callPage = async (paging: PagingArgs) => {
    calls.push(paging);
    const limit = Math.min(paging.limit, 200);
    const items = rows.slice(paging.offset, paging.offset + limit);
    const hasMore = paging.offset + items.length < rows.length;
    return { items, pagination: { limit, offset: paging.offset, total: rows.length, hasMore, nextOffset: hasMore ? paging.offset + items.length : null, nextCursor: null } };
  };
  return { calls, callPage };
}

describe('pagedBody', () => {
  it('reads the paged envelope and nothing else', () => {
    const page = { items: [1], pagination: { limit: 50, offset: 0, total: 1, hasMore: false, nextOffset: null, nextCursor: null } };
    expect(pagedBody(page)).toBe(page);
    expect(pagedBody({ records: [1], total: 1 })).toBeNull();
    expect(pagedBody([1, 2])).toBeNull();
    expect(pagedBody(null)).toBeNull();
    expect(pagedBody({ items: [1] })).toBeNull(); // `items` without `pagination` (lists.getItems' old shape) is not a page
  });
});

describe('readAllPages', () => {
  it('follows hasMore / nextOffset across pages on a paging Hub', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => `r${i}`);
    const hub = pagingHub(rows);

    const out = await readAllPages(hub.callPage, rowsOf, 1000);

    expect(out).toEqual(rows);
    expect(hub.calls.map((c) => c.offset)).toEqual([0, 200, 400]);
    expect(hub.calls.every((c) => c.paginate === true && c.limit === 1000)).toBe(true); // the Hub lowers it to 200
  });

  it('makes one call when everything fits a page', async () => {
    const hub = pagingHub(['a', 'b']);
    expect(await readAllPages(hub.callPage, rowsOf)).toEqual(['a', 'b']);
    expect(hub.calls).toHaveLength(1);
  });

  it('reads the old { records } answer of a Hub without paging, once, with the old limit', async () => {
    const calls: PagingArgs[] = [];
    const out = await readAllPages(
      async (paging) => {
        calls.push(paging);
        return { records: ['a', 'b', 'c'], total: 3, totalCapped: false };
      },
      rowsOf,
      1000,
    );
    expect(out).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual([{ paginate: true, limit: 1000, offset: 0 }]);
  });

  it('reads an old bare-array answer, and an empty answer as no rows', async () => {
    expect(await readAllPages(async () => ['x', 'y'], rowsOf)).toEqual(['x', 'y']);
    expect(await readAllPages(async () => null, rowsOf)).toEqual([]);
  });

  it('stops when the Hub says hasMore but nextOffset does not move forward', async () => {
    let calls = 0;
    const out = await readAllPages(
      async () => {
        calls++;
        return { items: ['a'], pagination: { limit: 200, offset: 0, total: null, hasMore: true, nextOffset: 0, nextCursor: null } };
      },
      rowsOf,
    );
    expect(out).toEqual(['a']);
    expect(calls).toBe(1);
  });

  it('keeps reading when total is null — only hasMore decides', async () => {
    const pages = [
      { items: ['a'], pagination: { limit: 1, offset: 0, total: null, hasMore: true, nextOffset: 1, nextCursor: null } },
      { items: ['b'], pagination: { limit: 1, offset: 1, total: null, hasMore: false, nextOffset: null, nextCursor: null } },
    ];
    let i = 0;
    expect(await readAllPages(async () => pages[i++], rowsOf)).toEqual(['a', 'b']);
  });
});
