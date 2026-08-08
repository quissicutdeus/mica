import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { GENERIC_SERVICE_ACTION } from '@shared/rpc';

export interface CrudEvents {
  list: string;
  create?: string;
  update?: string;
  remove?: string;
}

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
   * gPhone.
   *
   * Core services leave it unset and keep their named routes, which `routes.test.ts`
   * cross-references against the server and the mock — a check worth keeping for the apps
   * that ship in-tree.
   */
  service?: string;
}

const timeOf = (value: unknown): number => {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Newest first, by a date field, tolerating rows that have not got one. */
export const byNewest =
  <T>(field: keyof T) =>
  (a: T, b: T): number =>
    timeOf(b[field]) - timeOf(a[field]);

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
 * Writes deliberately have no `defaultValue`, so `fetchNui` throws and the caller can
 * tell that nothing happened. Reads pass `[]`, because an empty list beats an exception.
 */
export function createCrudStore<T extends { id: number }, TDraft = Omit<T, 'id'>>(
  name: string,
  events: CrudEvents,
  options: CrudOptions<T, TDraft> = {}
) {
  const { subscribe, set, update: mutate } = writable<T[]>([]);

  /**
   * One transport, two routes to the same server.
   *
   * Without `service`, `events` are NUI action names from `shared/routes.ts` — the path
   * every core service uses, and the one `routes.test.ts` cross-references. With it, they
   * are **server action names** (`get`, `create`) sent through the one generic callback,
   * which is the only path available to an app the Store installed: it cannot add a row
   * to a route table that ships inside gPhone.
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

  const required = (event: string | undefined, action: string): string => {
    if (!event) throw new Error(`The ${name} store has no ${action} event.`);
    return event;
  };

  return {
    subscribe,
    loaded: { subscribe: loaded.subscribe },

    load: async (): Promise<void> => {
      try {
        const data = await request<T[]>(events.list, null, { defaultValue: [] as T[] });
        if (!Array.isArray(data)) {
          console.error(`${name} store received invalid data:`, data);
          set([]);
          return;
        }
        set(ordered(data));
      } finally {
        loaded.set(true);
      }
    },

    add: async (draft: TDraft): Promise<T> => {
      options.validate?.(draft);
      const created = await request<T>(required(events.create, 'create'), draft);
      mutate((rows) => ordered([...rows, created]));
      return created;
    },

    update: async (row: T): Promise<void> => {
      options.validate?.(row);
      await request(required(events.update, 'update'), row);
      mutate((rows) => ordered(rows.map((r) => (r.id === row.id ? row : r))));
    },

    delete: async (id: number): Promise<void> => {
      await request(required(events.remove, 'delete'), { id });
      mutate((rows) => rows.filter((r) => r.id !== id));
    },

    /** For the paths a list alone cannot express — an incoming message, a local patch. */
    set: (rows: T[]) => set(ordered(rows)),
    patch: (id: number, changes: Partial<T>) =>
      mutate((rows) => ordered(rows.map((r) => (r.id === id ? { ...r, ...changes } : r))))
  };
}
