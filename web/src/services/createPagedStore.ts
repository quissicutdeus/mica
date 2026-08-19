import { writable, type Readable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { GENERIC_SERVICE_ACTION } from '@shared/rpc';

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
  options: {
    pageSize?: number;
    /**
     * Reach the server through the generic service route rather than a named NUI action.
     *
     * Set it and `action` becomes a **server** action name — `get`, `following` — instead
     * of a row in `shared/routes.ts`. That table and `web/src/services/` both ship inside
     * gPhone, so an app installed from the Store can add to neither; this is the only path
     * open to it. Mirrors `CrudOptions.service`, deliberately: an app should not have to
     * learn two different ways to say the same thing depending on whether its list is
     * paged.
     */
    service?: string;
  } = {}
): PagedStore<T> {
  const rows = writable<T[]>([]);
  const loaded = writable(false);
  const hasMore = writable(false);

  let cursor: number | null = null;
  let filter: Record<string, unknown> = {};
  /** Guards against a scroll handler firing twice before the first reply lands. */
  let inFlight = false;

  /**
   * No `defaultValue`, so a transport failure or a server error throws instead of being
   * masked into a fake empty page — `load`/`loadMore` decide what a failure should do to
   * the window they're already holding, which "return an empty page" cannot express.
   */
  const fetchPage = async (from: number | null): Promise<PagedReply<T>> => {
    const payload = { ...filter, cursor: from ?? undefined, limit: options.pageSize };
    const reply = await fetchNui<PagedReply<T>>(
      options.service ? GENERIC_SERVICE_ACTION : action,
      options.service ? { service: options.service, action, data: payload } : payload
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
      } catch (e) {
        console.warn(`Paged store '${action}' failed to load; keeping the last known page.`, e);
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
      } catch (e) {
        console.warn(`Paged store '${action}' failed to load more; leaving the cursor as-is.`, e);
        return false;
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
