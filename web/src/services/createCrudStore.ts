import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';

export interface CrudEvents {
  list: string;
  create?: string;
  update?: string;
  remove?: string;
}

export interface CrudOptions<T> {
  /**
   * One order for the list, however it changed.
   *
   * This is what "append vs prepend" was really asking. Notes pushed new rows onto the
   * end, Photos unshifted them onto the front, and Photos sorted on load but not after
   * an add — so a photo taken while the gallery was open sat in the right place only
   * until the next reload. A comparator settles it once for every path.
   */
  sort?: (a: T, b: T) => number;
  /** Throw to refuse a write before it leaves the phone. The message reaches the user. */
  validate?: (draft: any) => void;
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
  options: CrudOptions<T> = {}
) {
  const { subscribe, set, update: mutate } = writable<T[]>([]);

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
        const data = await fetchNui<T[]>(events.list, null, { defaultValue: [] as T[] });
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
      const created = await fetchNui<T>(required(events.create, 'create'), draft);
      mutate((rows) => ordered([...rows, created]));
      return created;
    },

    update: async (row: T): Promise<void> => {
      options.validate?.(row);
      await fetchNui(required(events.update, 'update'), row);
      mutate((rows) => ordered(rows.map((r) => (r.id === row.id ? row : r))));
    },

    delete: async (id: number): Promise<void> => {
      await fetchNui(required(events.remove, 'delete'), { id });
      mutate((rows) => rows.filter((r) => r.id !== id));
    },

    /** For the paths a list alone cannot express — an incoming message, a local patch. */
    set: (rows: T[]) => set(ordered(rows)),
    patch: (id: number, changes: Partial<T>) =>
      mutate((rows) => ordered(rows.map((r) => (r.id === id ? { ...r, ...changes } : r))))
  };
}
