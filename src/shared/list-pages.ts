/**
 * Opt-in paging of the Hub's MCP list tools (`paginate: true`, privos-hub#692;
 * `privos-dev-docs/mcp-app-platform/list-pagination.md`), shared by the
 * server's `AppDbBotClient` and the iframe's `AppDbClient` so the loop and the
 * old-Hub fallback exist once.
 *
 * With `paginate: true` a list tool answers `{ items, pagination }`; `hasMore`
 * is exact, `total` may be `null`, and `db.query` stops counting at 10,000
 * (`totalCapped`). A Hub without the feature ignores `paginate` and answers the
 * tool's old shape (`{ records, total, totalCapped }` for `db.query`) — so
 * every reader checks for `pagination` before trusting it.
 */

/** The Hub's page maximum with `paginate: true`; a larger `limit` is lowered to it. */
export const LIST_PAGE_MAX = 200;

export interface ListPagination {
  limit: number;
  offset: number;
  /** `null` when the Hub does not say (isolated list for a member, a slow count). */
  total: number | null;
  /** `db.query`: `total` stopped at the 10,000 cap — the real number is higher. */
  totalCapped?: boolean;
  hasMore: boolean;
  nextOffset: number | null;
  nextCursor: string | null;
}

export interface PagedBody {
  items: unknown[];
  pagination: ListPagination;
}

/** The paged envelope, or `null` for a Hub that answered the old shape. */
export function pagedBody(body: unknown): PagedBody | null {
  const candidate = body as Partial<PagedBody> | null | undefined;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const pagination = candidate.pagination;
  if (!pagination || typeof pagination !== 'object' || !Array.isArray(candidate.items)) return null;
  return candidate as PagedBody;
}

export interface PagingArgs {
  paginate: true;
  limit: number;
  offset: number;
}

/**
 * Every row of a list tool, page by page. `callPage` makes one call with the
 * paging args spread into its own; `rowsOf` reads rows out of the OLD shape a
 * Hub without paging returns, and is also handed each page's bare `items`
 * array (so a reader that accepts an array keeps its row filter on both).
 *
 * `legacyLimit` is the limit the call used before paging: a paging Hub lowers
 * it to `LIST_PAGE_MAX` and pages on, a Hub without paging returns up to that
 * many rows in one answer, exactly as it did — one call either way.
 */
export async function readAllPages<T>(
  callPage: (paging: PagingArgs) => Promise<unknown>,
  rowsOf: (body: unknown) => T[],
  legacyLimit: number = LIST_PAGE_MAX,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; ) {
    const body = await callPage({ paginate: true, limit: legacyLimit, offset });
    const page = pagedBody(body);
    if (!page) return offset === 0 ? rowsOf(body) : rows; // older Hub: its one answer, read as today
    rows.push(...rowsOf(page.items));
    const { hasMore, nextOffset } = page.pagination;
    // `nextOffset` must move forward — never loop on a Hub answer that does not advance.
    if (!hasMore || typeof nextOffset !== 'number' || nextOffset <= offset) return rows;
    offset = nextOffset;
  }
}
