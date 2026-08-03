import { writable, type Readable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';

/**
 * A store over a server-paged list.
 *
 * A sibling of `createCrudStore` rather than a mode of it. The two genuinely differ: a CRUD
 * store loads everything once and holds the whole set, while this one holds a *window* that
 * grows, tracks a cursor, and knows whether the server has more. Teaching one factory to guess
 * which reply shape it got works right up until a service forgets to declare `paging`.
 *
 * The wire shape is `{ rows, nextCursor }`, and `nextCursor: null` means the end. A client that
 * cannot tell "no more" from "ask again" scrolls forever.
 */

export interface PagedStore<T> extends Readable<T[]> {
  /** False until the first page has come back. An empty list is not the same as "none yet". */
  loaded: Readable<boolean>;
  /** Whether the server said there is another page. */
  hasMore: Readable<boolean>;
  /** Replace the window with a fresh first page. */
  load(filter?: Record<string, unknown>): Promise<void>;
  /** Append the next page. Returns whether anything arrived. */
  loadMore(): Promise<boolean>;
  /** Put a row at the head — an optimistic insert after a successful post. */
  prepend(row: T): void;
  /** Replace a row in place, by id. */
  replace(row: T): void;
  /** Drop a row, by id. */
  remove(id: number): void;
}

interface PagedReply<T> {
  rows: T[];
  nextCursor: number | null;
}

export function createPagedStore<T extends { id: number }>(
  action: string,
  options: { pageSize?: number } = {}
): PagedStore<T> {
  const rows = writable<T[]>([]);
  const loaded = writable(false);
  const hasMore = writable(false);

  let cursor: number | null = null;
  let filter: Record<string, unknown> = {};
  /** Guards against a scroll handler firing twice before the first reply lands. */
  let inFlight = false;

  /**
   * `defaultValue` supplied, so a transport failure yields an empty page rather than throwing.
   * A feed that cannot reach the server should render as empty, not tear down the app —
   * `fetchNui`'s contract hinges on exactly this distinction.
   */
  const fetchPage = async (from: number | null): Promise<PagedReply<T>> => {
    const reply = await fetchNui<PagedReply<T>>(
      action,
      { ...filter, cursor: from ?? undefined, limit: options.pageSize },
      { defaultValue: { rows: [], nextCursor: null } }
    );
    // A mock or an older server could answer with a bare array; treat it as one full page
    // rather than rendering nothing and looking like an empty feed.
    if (Array.isArray(reply)) return { rows: reply as T[], nextCursor: null };
    return { rows: reply?.rows ?? [], nextCursor: reply?.nextCursor ?? null };
  };

  return {
    subscribe: rows.subscribe,
    loaded: { subscribe: loaded.subscribe },
    hasMore: { subscribe: hasMore.subscribe },

    load: async (next: Record<string, unknown> = {}) => {
      filter = next;
      cursor = null;
      inFlight = true;
      try {
        const page = await fetchPage(null);
        rows.set(page.rows);
        cursor = page.nextCursor;
        hasMore.set(page.nextCursor !== null);
      } finally {
        inFlight = false;
        loaded.set(true);
      }
    },

    loadMore: async () => {
      if (inFlight || cursor === null) return false;
      inFlight = true;
      try {
        const page = await fetchPage(cursor);
        cursor = page.nextCursor;
        hasMore.set(page.nextCursor !== null);
        if (page.rows.length === 0) return false;
        // Appended, because the cursor walks backwards through `id DESC` — older rows belong
        // at the tail.
        rows.update((current) => [...current, ...page.rows]);
        return true;
      } finally {
        inFlight = false;
      }
    },

    prepend: (row: T) => rows.update((current) => [row, ...current]),
    replace: (row: T) =>
      rows.update((current) =>
        current.map((existing) => (existing.id === row.id ? row : existing))
      ),
    remove: (id: number) => rows.update((current) => current.filter((row) => row.id !== id))
  };
}
