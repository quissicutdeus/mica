// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, type Readable } from 'svelte/store';
import { fetchNui } from './nui/transport';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import type {
  AddonActionInput,
  AddonActionName,
  AddonActionOutput,
  AddonServiceDeclaration
} from '@mica/shared/addonService';

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

/**
 * Where the next page starts, as the server said it.
 *
 * Opaque here on purpose. Almost every paged read in the phone walks `id DESC` and a bare row
 * id is the whole cursor, but the inbox does not: it is ordered by last-message recency, so its
 * cursor is a `{ time, id }` pair (MICA-211). This store never reads inside a cursor — it
 * takes what came back and sends it on the next request — so widening the type is the whole
 * change, and a service that needs a third shape needs nothing here at all.
 */
export type PageCursor = number | string | Record<string, unknown>;

interface PagedReply<T> {
  rows: T[];
  nextCursor: PageCursor | null;
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

/** `createPagedStore`'s options, in the string and reader forms. */
interface PagedOptions {
  pageSize?: number;
  /**
   * Reach the server through the generic service route rather than a named NUI action.
   *
   * Set it and `action` becomes a **server** action name — `get`, `following` — instead
   * of a row in `shared/routes.ts`. That table and `web/src/services/` both ship inside
   * micaOS, so an app installed from the Store can add to neither; this is the only path
   * open to it. Mirrors `CrudOptions.service`, deliberately: an app should not have to
   * learn two different ways to say the same thing depending on whether its list is
   * paged.
   */
  service?: string;
}

/** The one implementation behind both of `createPagedStore`'s front doors. */
function pagedStore<T extends { id: number }>(
  action: string | PageReader<T>,
  options: PagedOptions
): PagedStore<T> {
  const rows = writable<T[]>([]);
  const loaded = writable(false);
  const hasMore = writable(false);

  let cursor: PageCursor | null = null;
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
  const fetchPage = async (from: PageCursor | null): Promise<PagedReply<T>> => {
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
        // Appended, because the cursor walks backwards through whatever order the server sorts
        // by — `id DESC` for most lists, last-message recency for the inbox — so a later page
        // is always older than what is already held and belongs at the tail.
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

// --- The declaration form (MICA-313) ---------------------------------------------------------
//
// As `createCrudStore`'s: the action is checked against the declaration by a conditional type
// that answers the name when it fits and a sentence when it does not. What it checks is what
// this store sends — `{ ...filter, cursor, limit }`, with `cursor` absent on the first page and
// `limit` absent without a `pageSize` — and what it reads back, since the server parses every
// payload strictly against the same declaration and refuses a key it does not declare.

type Out<D extends AddonServiceDeclaration, A extends AddonActionName<D>> = AddonActionOutput<D, A>;
type In<D extends AddonServiceDeclaration, A extends AddonActionName<D>> = AddonActionInput<D, A>;

/** `true` for one action name, `false` for the union an unknown name falls back to. */
type IsOne<A, All = A> = A extends unknown ? ([All] extends [A] ? true : false) : never;

/** A page's row: from `{ rows: Row[], nextCursor }`, or from a bare `Row[]` (one page). */
type PageRow<O> = O extends readonly (infer R)[]
  ? R
  : O extends { rows: readonly (infer R)[] }
    ? R
    : never;

/** The paged read: answers rows with an id, and takes back the cursor it hands out. */
type PageEvent<D extends AddonServiceDeclaration, A extends AddonActionName<D>> =
  IsOne<A> extends false
    ? AddonActionName<D>
    : [PageRow<Out<D, A>>] extends [never]
      ? `'${A}' must answer a page: declare output: addonOutput<{ rows: Row[]; nextCursor: number | null }>()`
      : PageRow<Out<D, A>> extends { id: number }
        ? Out<D, A> extends { nextCursor: infer N }
          ? 'cursor' extends keyof In<D, A>
            ? NonNullable<N> extends NonNullable<In<D, A>['cursor']>
              ? object extends Pick<In<D, A>, 'cursor'>
                ? A
                : `'${A}' must declare 'cursor' optional: the first page is asked for without one`
              : `'${A}' must accept its own nextCursor as 'cursor'`
            : `'${A}' must declare an optional 'cursor' field: the store sends back nextCursor`
          : A
        : `'${A}' must answer rows with an id: number`;

/**
 * A server-paged list over an add-on's own service, typed from its declaration (MICA-313).
 *
 * The declaration your server half registers, and the action that reads one page. Its output
 * is `addonOutput<{ rows: Row[]; nextCursor: … | null }>()` — or `addonOutput<Row[]>()` for a
 * list that is always one page — and `Row`, which needs an `id: number`, is the store's row
 * type. The action is sent `{ ...filter, cursor, limit }`, so it declares an optional `cursor`
 * of the type `nextCursor` hands out, and a `limit` field if you set `pageSize`; whatever
 * `load(filter)` adds must be declared too, or the server refuses it.
 *
 * ```ts
 * const feed = createPagedStore(journal, 'page', { pageSize: 20 });
 * ```
 *
 * At run time it is `createPagedStore(action, { ...options, service: declaration.id })`: the
 * same store, through the same generic service route, refused by the shell for any id but your
 * own.
 */
export function createPagedStore<
  const D extends AddonServiceDeclaration,
  A extends AddonActionName<D>
>(
  declaration: D,
  action: PageEvent<D, A>,
  options?: {
    /** Sent as `limit`, so the action must declare a `limit` field to take it. */
    pageSize?: 'limit' extends keyof In<D, A>
      ? number
      : `'${A}' must declare a 'limit' field to take a pageSize`;
  }
): PagedStore<PageRow<Out<D, A>>>;
/**
 * A server-paged list: by NUI action name, by server action name with `service:` set, or
 * through a reader function. See the module comment above.
 */
// Last on purpose: the general form, and the one a reader of the type sees (`createCrudStore`
// and `useService` order theirs the same way).
export function createPagedStore<T extends { id: number }>(
  /**
   * The NUI action, the server action (with `service:` set), or the reader itself. A
   * function is also what keeps `server/__tests__/routes.test.ts`'s scanner from reading
   * the name as a route nobody declared — there is no name to read.
   */
  action: string | PageReader<T>,
  options?: PagedOptions
): PagedStore<T>;
export function createPagedStore(
  target: string | PageReader<{ id: number }> | AddonServiceDeclaration,
  actionOrOptions?: string | PagedOptions,
  declaredOptions: { pageSize?: number } = {}
): PagedStore<{ id: number }> {
  if (typeof target === 'object') {
    // Refused rather than coerced: `String({ pageSize })` would page an action named
    // '[object Object]', and the server's refusal would not say which call sent it.
    if (typeof actionOrOptions !== 'string') {
      throw new Error(
        `createPagedStore('${target.id}'): the declaration form takes the action name second.`
      );
    }
    return pagedStore(actionOrOptions, { ...declaredOptions, service: target.id });
  }
  return pagedStore(target, typeof actionOrOptions === 'object' ? actionOrOptions : {});
}
