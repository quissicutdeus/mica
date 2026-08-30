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

/**
 * A page read, for a list that no NUI action or `useService` call can reach.
 *
 * The third door, and the one an add-on needs for a *shared* service: a named NUI action
 * is refused inside the sandbox (`sdk/host/iframe/fetchNui.ts`) and the generic service
 * route is pinned to the app's own namespace (`IframeHostServer`'s `serviceAllowed`), so
 * a list like the follow graph is reachable only through its enumerated facet —
 * `useAccounts().getFollowers`. Passing that function here keeps the paging (cursor,
 * `hasMore`, the optimistic `prepend`/`replace`/`remove`) instead of reimplementing it
 * per app.
 */
export type PageReader<T> = (payload: Record<string, unknown>) => Promise<PagedReply<T> | T[]>;

export function createPagedStore<T extends { id: number }>(
  /**
   * The NUI action, the server action (with `service:` set), or the reader itself. A
   * function is also what keeps `server/__tests__/routes.test.ts`'s scanner from reading
   * the name as a route nobody declared — there is no name to read.
   */
  action: string | PageReader<T>,
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
   * Bumped at the start of every `load`/`loadMore` request, and captured by that request as
   * `myGeneration`. MICA-117: `loadMore` refusing to start while `inFlight` never covered
   * `load`, which resets the window unconditionally — so an outstanding `loadMore`, launched
   * before that `load` and still awaiting its reply, used to land afterward and apply its
   * now-meaningless cursor and rows on top of the fresh page one. Checking `generation` after
   * every await, and dropping a reply whose generation has been superseded, makes the *last*
   * request to start the only one allowed to touch state — whichever of `load`/`loadMore` that
   * is, and however the two interleave.
   */
  let generation = 0;
  /** What the warnings below name the store, since `action` may be an anonymous reader. */
  const label = typeof action === 'function' ? action.name || 'reader' : action;

  /**
   * No `defaultValue`, so a transport failure or a server error throws instead of being
   * masked into a fake empty page — `load`/`loadMore` decide what a failure should do to
   * the window they're already holding, which "return an empty page" cannot express.
   */
  const fetchPage = async (from: number | null): Promise<PagedReply<T>> => {
    const payload = { ...filter, cursor: from ?? undefined, limit: options.pageSize };
    const reply =
      typeof action === 'function'
        ? await action(payload)
        : await fetchNui<PagedReply<T>>(
            options.service ? GENERIC_SERVICE_ACTION : action,
            options.service ? { service: options.service, action, data: payload } : payload
          );
    // A mock or an older server could answer with a bare array; treat it as one full page
    // rather than rendering nothing and looking like an empty feed.
    if (Array.isArray(reply)) return { rows: reply, nextCursor: null };
    return { rows: reply?.rows ?? [], nextCursor: reply?.nextCursor ?? null };
  };

  return {
    subscribe: rows.subscribe,
    loaded: { subscribe: loaded.subscribe },
    hasMore: { subscribe: hasMore.subscribe },

    load: async (next: Record<string, unknown> = {}) => {
      filter = next;
      const myGeneration = ++generation;
      // MICA-118: no eager `cursor = null` here. Clearing it up front left `cursor` and
      // `hasMore` disagreeing for as long as a failed request's `catch` ran — `hasMore` still
      // true from the last good page, `cursor` already null, and `loadMore`'s own
      // `cursor === null` guard then refused every retry forever with nothing logged. Leaving
      // `cursor` alone until a reply actually succeeds means a failure leaves the window in
      // exactly the state a caller would expect: unchanged, and retryable from where it was.
      inFlight = true;
      try {
        const page = await fetchPage(null);
        // MICA-117: an outstanding `loadMore` (or an even newer `load`) may have already
        // landed and moved `generation` on — this reply describes a window that no longer
        // exists, so it is dropped rather than applied.
        if (generation !== myGeneration) return;
        rows.set(page.rows);
        cursor = page.nextCursor;
        hasMore.set(page.nextCursor !== null);
      } catch (e) {
        console.warn(`Paged store '${label}' failed to load; keeping the last known page.`, e);
      } finally {
        // Only the request that is still the latest gets to say the store is idle — an
        // earlier, now-superseded call finishing later must not clear a busy flag a newer
        // request is still relying on.
        if (generation === myGeneration) {
          inFlight = false;
          loaded.set(true);
        }
      }
    },

    loadMore: async () => {
      if (inFlight || cursor === null) return false;
      const myGeneration = ++generation;
      inFlight = true;
      try {
        const page = await fetchPage(cursor);
        // MICA-117: a `load` that started after this `loadMore` already replaced the
        // window by the time this reply lands — appending onto it, or overwriting its
        // cursor, would silently corrupt state this call knows nothing about.
        if (generation !== myGeneration) return false;
        cursor = page.nextCursor;
        hasMore.set(page.nextCursor !== null);
        if (page.rows.length === 0) return false;
        // Appended, because the cursor walks backwards through `id DESC` — older rows belong
        // at the tail.
        rows.update((current) => [...current, ...page.rows]);
        return true;
      } catch (e) {
        console.warn(`Paged store '${label}' failed to load more; leaving the cursor as-is.`, e);
        return false;
      } finally {
        if (generation === myGeneration) inFlight = false;
      }
    },

    // A `load`/`loadMore` racing the create this optimistically follows may already have
    // pulled `row` in from the server — unshifting it again would show it twice. Replace
    // in place (keeping the server's sorted position) if it's already there, unshift only
    // if it isn't (MICA-119).
    prepend: (row: T) =>
      rows.update((current) =>
        current.some((r) => r.id === row.id)
          ? current.map((r) => (r.id === row.id ? row : r))
          : [row, ...current]
      ),
    replace: (row: T) =>
      rows.update((current) =>
        current.map((existing) => (existing.id === row.id ? row : existing))
      ),
    remove: (id: number) => rows.update((current) => current.filter((row) => row.id !== id))
  };
}
