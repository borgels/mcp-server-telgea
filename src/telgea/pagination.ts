import type { QueryValue, TelgeaClient } from './client.js';

export const MAX_PAGES_LIMIT = 10;

interface PageResponse<T> {
  page?: number;
  pageSize?: number;
  itemsCount?: number;
  items?: T[];
}

export interface PagedResult<T> {
  items: T[];
  itemsCount?: number;
  firstPage: number;
  lastPage: number;
  pageSize?: number;
  /** Pass as `page` to continue; absent when everything was returned. */
  nextPage?: number;
}

/**
 * Walk page-numbered Telgea lists. Defaults to one page: every page is a
 * request against the 1000/day budget, so the caller opts in to more.
 */
export async function fetchPages<T>(
  client: TelgeaClient,
  path: string,
  query: Record<string, QueryValue>,
  options: { page?: number; pageSize?: number; maxPages?: number },
): Promise<PagedResult<T>> {
  const firstPage = options.page ?? 1;
  const maxPages = Math.min(Math.max(options.maxPages ?? 1, 1), MAX_PAGES_LIMIT);
  const items: T[] = [];
  let page = firstPage;
  let itemsCount: number | undefined;
  let pageSize = options.pageSize;
  let more = false;

  for (let fetched = 0; fetched < maxPages; fetched += 1) {
    const response = await client.get<PageResponse<T>>(path, { ...query, page, pageSize: options.pageSize });
    const batch = response?.items ?? [];
    items.push(...batch);
    itemsCount = response?.itemsCount ?? itemsCount;
    pageSize = response?.pageSize ?? pageSize;
    const seen = (page - 1) * (pageSize ?? batch.length) + batch.length;
    more = batch.length > 0 && (itemsCount === undefined ? batch.length === pageSize : seen < itemsCount);
    if (!more) break;
    page += 1;
  }

  return {
    items,
    itemsCount,
    firstPage,
    lastPage: more ? page - 1 : page,
    pageSize,
    nextPage: more ? page : undefined,
  };
}

interface CursorResponse<T> {
  items?: T[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

export async function fetchCursorPages<T>(
  client: TelgeaClient,
  path: string,
  query: Record<string, QueryValue>,
  options: { cursor?: string; maxPages?: number },
): Promise<{ items: T[]; nextCursor?: string; hasMore: boolean }> {
  const maxPages = Math.min(Math.max(options.maxPages ?? 1, 1), MAX_PAGES_LIMIT);
  const items: T[] = [];
  let cursor = options.cursor;
  let hasMore = false;

  for (let fetched = 0; fetched < maxPages; fetched += 1) {
    const response = await client.get<CursorResponse<T>>(path, { ...query, cursor });
    items.push(...(response?.items ?? []));
    hasMore = Boolean(response?.hasMore && response.nextCursor);
    cursor = response?.nextCursor ?? undefined;
    if (!hasMore) break;
  }

  return { items, nextCursor: hasMore ? cursor : undefined, hasMore };
}
