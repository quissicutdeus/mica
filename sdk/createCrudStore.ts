// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { fetchNui } from './nui/transport';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import type {
  AddonActionInput,
  AddonActionName,
  AddonActionOutput,
  AddonServiceDeclaration
} from '@mica/shared/addonService';

/** The NUI action names a `createCrudStore` reads and writes through. */
export interface CrudEvents {
  list: string;
  create?: string;
  update?: string;
  remove?: string;
}

/** Configuration for `createCrudStore` — sort order, validation, and the events it uses. */
export interface CrudOptions<T, TDraft> {
  /**
   * One order for the list, however it changed.
   *
   * This is what "append vs prepend" was really asking. Notes pushed new rows onto the
   * end, Photos unshifted them onto the front, and Photos sorted on load but not after
   * an add — so a photo taken while the gallery was open sat in the right place only
   * until the next reload. A comparator settles it once for every path.
   */
  sort?: (a: T, b: T) => number;
  /**
   * Throw to refuse a write before it leaves the phone. The message reaches the user.
   *
   * Runs on both paths, and they do not carry the same shape: `add` passes a `TDraft`
   * with no `id` yet, `update` passes a whole `T`. A validator therefore has to accept
   * either — `Partial<Contact>` is what the one implementation actually takes — which is
   * what the previous `any` was standing in for.
   */
  validate?: (draft: TDraft | T) => void;
  /**
   * Reach the server through the generic service route instead of named NUI actions.
   *
   * Set it and `events` become **server** action names — `get`, `create`, `update`,
   * `delete` — rather than rows in `shared/routes.ts`. That is the only path open to an
   * app installed from the Store, which cannot add a route to a table shipping inside
   * micaOS.
   *
   * A core service sets it too whenever an action it lists is contracted (MICA-213):
   * `routes.test.ts` then holds each scoped mock to a registered server event, the same
   * check a named route got. Named routes remain only for generic CRUD reached by NUI name.
   */
  service?: string;
}

const timeOf = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(
    typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  );
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Each row's parsed time, per field, remembered across sorts.
 *
 * A sort calls its comparator ~n·log n times, and parsing both sides on every call made a
 * full sort of the inbox cost twice that many `Date.parse`s. Keyed by the row object, so
 * a row that is replaced (every store here spreads a new object on change) is parsed once
 * and then free on every later sort — `conversations.ts` re-sorts its whole window on each
 * live arrival, and only the arrival is new. The raw value is kept beside the time and
 * compared on every hit, so a row mutated in place re-parses instead of answering stale:
 * correctness does not depend on callers never mutating. A `Date` is not memoised at all,
 * since `getTime()` is already cheap and `setTime()` would mutate it under an unchanged key.
 */
type ParsedTime = { raw: unknown; time: number };
const parsedTimes = new WeakMap<object, Map<PropertyKey, ParsedTime>>();

const rowTimeOf = <T>(row: T, field: keyof T): number => {
  const raw = row[field];
  if (typeof row !== 'object' || row === null || raw instanceof Date) return timeOf(raw);
  let byField = parsedTimes.get(row);
  if (!byField) parsedTimes.set(row, (byField = new Map<PropertyKey, ParsedTime>()));
  const hit = byField.get(field);
  if (hit && Object.is(hit.raw, raw)) return hit.time;
  const time = timeOf(raw);
  byField.set(field, { raw, time });
  return time;
};

/** Newest first, by a date field, tolerating rows that have not got one. */
export const byNewest =
  <T>(field: keyof T) =>
  (a: T, b: T): number =>
    rowTimeOf(b, field) - rowTimeOf(a, field);

/**
 * Where `row` goes in `rows` — already ordered by `compare`, and not holding `row` — so the
 * result is exactly what a stable full sort would give.
 *
 * `from` is the index `row` held in the list being sorted. A stable sort keeps rows that
 * compare equal in their input order, so among `row`'s ties the ones that came before it stay
 * before it and the rest after: the answer is `from`, clamped into the run of ties. An append
 * passes `rows.length`, which lands after every tie — what `[...rows, row].sort()` does.
 */
const positionFor = <T>(
  rows: readonly T[],
  row: T,
  from: number,
  compare: (a: T, b: T) => number
): number => {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(rows[mid], row) < 0) lo = mid + 1;
    else hi = mid;
  }
  const firstTie = lo;
  hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(rows[mid], row) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(Math.max(from, firstTie), lo);
};

/** The one implementation behind both of `createCrudStore`'s front doors. */
function crudStore<T extends { id: number }, TDraft>(
  name: string,
  events: CrudEvents,
  options: CrudOptions<T, TDraft>
) {
  const { subscribe, set, update: mutate } = writable<T[]>([]);

  /**
   * One transport, two routes to the same server.
   *
   * Without `service`, `events` are NUI action names from `shared/routes.ts` — the path
   * every core service uses, and the one `routes.test.ts` cross-references. With it, they
   * are **server action names** (`get`, `create`) sent through the one generic callback,
   * which is the only path available to an app the Store installed: it cannot add a row
   * to a route table that ships inside micaOS.
   *
   * Here rather than in a second store factory, because everything below this line — the
   * ordering, the `loaded` flag, the validation, refusing to optimistically assert a write
   * the server has not taken — is the part that took several rewrites to get right and is
   * exactly what an add-on should not have to reproduce to have a list.
   */
  const request = <R>(action: string, payload?: unknown, opts?: { defaultValue: R }) =>
    options.service
      ? fetchNui<R>(
          GENERIC_SERVICE_ACTION,
          { service: options.service, action, data: payload },
          opts
        )
      : fetchNui<R>(action, payload, opts);

  /**
   * False until the first load has come back, whatever it came back with.
   *
   * An empty list means two different things — still fetching, and nothing to show — and
   * no store could tell them apart, so every app stated "No photos yet" as fact for as
   * long as the round trip took. It stays true afterwards, so a refresh on re-entry does
   * not blank a list the player is already looking at.
   */
  const loaded = writable(false);

  const ordered = (rows: T[]): T[] => (options.sort ? [...rows].sort(options.sort) : rows);

  /**
   * The list after one row changed, in the order a full sort would give — without one.
   *
   * Every write used to re-sort the whole list, which is n·log n comparator calls to move at
   * most one row. The list is always held in order (`load` and `set` sort it, and every write
   * comes through here), so a single replaced row either still sits between its neighbours —
   * nothing moves — or is lifted out and dropped back in by binary search. That matches a
   * stable sort exactly for any consistent comparator, ties included; see `positionFor`.
   *
   * An id held twice is the one shape this does not reason about (`map` replaced every copy
   * and then sorted), so it keeps the full sort rather than guess.
   */
  const replaced = (rows: T[], id: number, next: (row: T) => T): T[] => {
    const compare = options.sort;
    const index = rows.findIndex((r) => r.id === id);
    const heldTwice = index !== -1 && rows.some((r, i) => i > index && r.id === id);
    if (!compare || heldTwice) return ordered(rows.map((r) => (r.id === id ? next(r) : r)));
    if (index === -1) return [...rows];

    const row = next(rows[index]);
    const result = [...rows];
    const fits =
      (index === 0 || compare(rows[index - 1], row) <= 0) &&
      (index === rows.length - 1 || compare(row, rows[index + 1]) <= 0);
    if (fits) {
      result[index] = row;
      return result;
    }
    result.splice(index, 1);
    result.splice(positionFor(result, row, index, compare), 0, row);
    return result;
  };

  /** `row` appended, then ordered — by one binary search rather than a sort. */
  const appended = (rows: T[], row: T): T[] => {
    if (!options.sort) return [...rows, row];
    const result = [...rows];
    result.splice(positionFor(result, row, result.length, options.sort), 0, row);
    return result;
  };

  const required = (event: string | undefined, action: string): string => {
    if (!event) throw new Error(`The ${name} store has no ${action} event.`);
    return event;
  };

  return {
    subscribe,
    loaded: { subscribe: loaded.subscribe },

    load: async (): Promise<void> => {
      try {
        const data = await request<T[]>(events.list, null);
        if (!Array.isArray(data)) {
          console.error(`${name} store received invalid data:`, data);
          set([]);
          return;
        }
        set(ordered(data));
      } catch (e) {
        console.warn(`${name} store failed to load; keeping the last known list.`, e);
      } finally {
        loaded.set(true);
      }
    },

    add: async (draft: TDraft): Promise<T> => {
      options.validate?.(draft);
      const created = await request<T>(required(events.create, 'create'), draft);
      // A `load()` racing this round trip may already have pulled `created` in from the
      // server — appending it again would show the row twice. Replace in place if it's
      // already there, append only if it isn't (MICA-119).
      mutate((rows) =>
        rows.some((r) => r.id === created.id)
          ? replaced(rows, created.id, () => created)
          : appended(rows, created)
      );
      return created;
    },

    update: async (row: T): Promise<void> => {
      options.validate?.(row);
      await request(required(events.update, 'update'), row);
      mutate((rows) => replaced(rows, row.id, () => row));
    },

    delete: async (id: number): Promise<void> => {
      await request(required(events.remove, 'delete'), { id });
      mutate((rows) => rows.filter((r) => r.id !== id));
    },

    /** For the paths a list alone cannot express — an incoming message, a local patch. */
    set: (rows: T[]) => set(ordered(rows)),
    patch: (id: number, changes: Partial<T>) =>
      mutate((rows) => replaced(rows, id, (r) => ({ ...r, ...changes })))
  };
}

/** What `createCrudStore` returns, whichever door it was called through. */
type CrudStore<T extends { id: number }, TDraft> = ReturnType<typeof crudStore<T, TDraft>>;

// --- The declaration form (MICA-313) ---------------------------------------------------------
//
// Each event is checked against the declaration by a conditional type that answers the event
// name itself when it fits, and a sentence when it does not — so a mismatch reads as
// `'"add"' is not assignable to '"'add' must answer …"'` rather than as a wall of mapped
// types. The checks mirror what the store actually sends, because the server parses every
// payload strictly against the same declaration (`addonInputSchema`): an unknown key is
// refused there, so a store that sent one would fail on every call.

type Out<D extends AddonServiceDeclaration, A extends AddonActionName<D>> = AddonActionOutput<D, A>;
type In<D extends AddonServiceDeclaration, A extends AddonActionName<D>> = AddonActionInput<D, A>;

/**
 * `true` for one action name, `false` for a union of them — which is what an event's type
 * parameter falls back to when the name written is not an action at all. Each check below
 * answers the declaration's names in that case, so the error reads "'lst' is not assignable
 * to 'list' | 'add'" instead of one sentence per action.
 */
type IsOne<A, All = A> = A extends unknown ? ([All] extends [A] ? true : false) : never;

/** The row type: the element of the `list` action's declared output. */
type ListedRow<D extends AddonServiceDeclaration, L extends AddonActionName<D>> =
  Out<D, L> extends readonly (infer R extends { id: number })[] ? R : never;

/** The draft type: the `create` action's input, or `never` when there is no `create`. */
type DraftOf<D extends AddonServiceDeclaration, C extends AddonActionName<D>> = [C] extends [never]
  ? never
  : In<D, C>;

/** `list` answers `Row[]`, rows carry `id: number`, and it takes no required input. */
type ListEvent<D extends AddonServiceDeclaration, L extends AddonActionName<D>> =
  IsOne<L> extends false
    ? AddonActionName<D>
    : Out<D, L> extends readonly unknown[]
      ? Out<D, L> extends readonly { id: number }[]
        ? object extends In<D, L>
          ? L
          : `'${L}' has a required input field, and the store lists with none`
        : `'${L}' must answer rows with an id: number`
      : `'${L}' must answer a list: declare output: addonOutput<Row[]>()`;

/** `create` answers the row it created, which the store adds to the list. */
type CreateEvent<D extends AddonServiceDeclaration, C extends AddonActionName<D>, Row> =
  IsOne<C> extends false
    ? AddonActionName<D>
    : unknown extends Out<D, C>
      ? `'${C}' must answer the row it created: declare output: addonOutput<Row>()`
      : Out<D, C> extends Row
        ? C
        : `'${C}' must answer the row it created: declare output: addonOutput<Row>()`;

/** `update` is sent the whole row, so its input must declare every field of it. */
type UpdateEvent<D extends AddonServiceDeclaration, U extends AddonActionName<D>, Row> =
  IsOne<U> extends false
    ? AddonActionName<D>
    : [Exclude<keyof Row, keyof In<D, U>>] extends [never]
      ? Row extends In<D, U>
        ? U
        : `'${U}' must accept the whole row: the store sends it as the input`
      : `'${U}' must declare every field of the row, id included: the store sends the whole row`;

/** `remove` is sent `{ id }` and nothing else. */
type RemoveEvent<D extends AddonServiceDeclaration, R extends AddonActionName<D>> =
  IsOne<R> extends false
    ? AddonActionName<D>
    : 'id' extends keyof In<D, R>
      ? { id: number } extends In<D, R>
        ? R
        : `'${R}' must take { id } alone: the store sends nothing else`
      : `'${R}' must declare an integer 'id' field: the store sends { id }`;

/**
 * A list over an add-on's own service, typed from its declaration (MICA-313).
 *
 * The declaration your server half registers, and the actions to use from it. Every name is
 * one of the declaration's, and the store's types follow from the declaration rather than from
 * a type argument you assert:
 *
 * - **`list`** answers `addonOutput<Row[]>()`, and `Row` — which needs an `id: number` — is
 *   the store's row type. It is called with no input.
 * - **`create`** takes the draft, so `add(draft)` is typed as its input, and answers the
 *   created row (`addonOutput<Row>()`).
 * - **`update`** is sent the whole row, so its input declares every field of `Row`.
 * - **`remove`** is sent `{ id }`.
 *
 * ```ts
 * const notes = createCrudStore(notesService, { list: 'list', create: 'add' });
 * await notes.add({ text }); // a typo in a field, or in an action name, fails to compile
 * ```
 *
 * At run time it is `createCrudStore(declaration.id, events, { ...options, service:
 * declaration.id })`: the same store, through the same generic service route. The types are a
 * convenience and a promise about nothing — the server parses every payload against the
 * declaration it was handed, and the shell refuses any id but your own, whatever this side
 * believed.
 */
export function createCrudStore<
  const D extends AddonServiceDeclaration,
  L extends AddonActionName<D>,
  C extends AddonActionName<D> = never,
  U extends AddonActionName<D> = never,
  R extends AddonActionName<D> = never
>(
  declaration: D,
  events: {
    list: ListEvent<D, L>;
    create?: CreateEvent<D, C, ListedRow<D, L>>;
    update?: UpdateEvent<D, U, ListedRow<D, L>>;
    remove?: RemoveEvent<D, R>;
  },
  options?: Omit<CrudOptions<ListedRow<D, L>, DraftOf<D, C>>, 'service'>
): CrudStore<ListedRow<D, L>, DraftOf<D, C>>;
/**
 * A store over a list of rows the server owns.
 *
 * Four stores had written the same load/add/update/delete by hand, and every difference
 * between them was an accident rather than a decision:
 *
 * - **Order** — see `sort` above.
 * - **Optimism** — Mail wrote to the list first and then told the server; everyone else
 *   waited. Optimism was load-bearing when `fetchNui` swallowed failures, because there
 *   was no other way to feel responsive. It now throws, so the list follows the server
 *   and a refused write no longer leaves the UI asserting something untrue.
 * - **Validation** — Contacts checked its required fields, in the store and again in the
 *   component; nobody else checked anything.
 * - **Bad data** — three stores logged and emptied the list on a non-array reply, one
 *   let it through.
 *
 * Neither reads nor writes pass a `defaultValue`, so `fetchNui` throws on failure instead
 * of masking it. Writes propagate the throw to the caller, which already had a value to
 * fall back to. `load` catches it itself and keeps the store's last known list — the
 * store has nothing better to show, and a background refresh that failed should not wipe
 * out what the player was already looking at.
 */
// Last on purpose: the string form is the general one, and the overload a reader of the type
// (`ReturnType`, `publicSurface.test.ts`) sees — as `useService` orders its two.
export function createCrudStore<T extends { id: number }, TDraft = Omit<T, 'id'>>(
  name: string,
  events: CrudEvents,
  options?: CrudOptions<T, TDraft>
): CrudStore<T, TDraft>;
// The implementation's own types are the loosest both doors meet at — each overload above is
// what a caller sees, and both lead straight to `crudStore`.
export function createCrudStore(
  target: string | AddonServiceDeclaration,
  events: CrudEvents,
  options: CrudOptions<never, never> = {}
): unknown {
  return typeof target === 'string'
    ? crudStore(target, events, options)
    : crudStore(target.id, events, { ...options, service: target.id });
}
