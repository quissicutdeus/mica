import type { MockHandler } from './registry';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface MockCrudEvents {
  list: string;
  create?: string;
  update?: string;
  remove?: string;
}

export interface MockCrudOptions<T> {
  /** Round-trip time to imitate. One number, so the phone feels the same everywhere. */
  delay?: number;
  /**
   * How the server deletes.
   *
   * Contacts and notes are removed outright; photos and mail keep the row and set
   * `status: 'deleted'`, because they can be reported and moderated after the fact. The
   * mock has to match, or the browser disagrees with the game about what a delete does.
   */
  remove?: 'hard' | 'soft';
  /** Rows the list does not return — soft-deleted ones, usually. */
  visible?: (row: T) => boolean;
  /** Where a created row lands. */
  insert?: 'append' | 'prepend';
  /** Fields the server would fill in beyond id, citizenid and timestamps. */
  defaults?: Record<string, unknown>;
}

let nextId = 10_000;

/**
 * Browser-mode handlers for a list the server owns.
 *
 * Written out by hand four times, and the copies disagreed about everything that was
 * never decided: notes and contacts mutated their fixtures while an earlier version of
 * photos and mail did not, so a created note vanished on reload and a created photo did
 * not. Delays were 200, 300 and 500ms for no reason. Two stores deleted rows and two
 * marked them, which is a real difference — so it is an option here rather than a habit.
 *
 * Ids come from a counter rather than `Math.random()`: a duplicate id is a bug the
 * browser would show and the game never would.
 */
export function defineMockCrud<T extends { id: number }>(
  rows: T[],
  events: MockCrudEvents,
  options: MockCrudOptions<T> = {}
): Record<string, MockHandler> {
  const wait = options.delay ?? 300;
  const visible = options.visible ?? (() => true);
  const handlers: Record<string, MockHandler> = {};

  handlers[events.list] = () => rows.filter(visible);

  if (events.create) {
    handlers[events.create] = async (draft: any) => {
      await delay(wait);
      const now = new Date().toISOString();
      const created = {
        citizenid: 'mock-id',
        ...options.defaults,
        ...draft,
        id: nextId++,
        created_at: draft?.created_at ?? now,
        updated_at: now
      } as T;
      if (options.insert === 'prepend') rows.unshift(created);
      else rows.push(created);
      return created;
    };
  }

  if (events.update) {
    handlers[events.update] = async (row: any) => {
      await delay(wait);
      const index = rows.findIndex((r) => r.id === row?.id);
      if (index !== -1) rows[index] = { ...rows[index], ...row };
      return row;
    };
  }

  if (events.remove) {
    handlers[events.remove] = async (data: { id: number }) => {
      await delay(wait);
      const index = rows.findIndex((r) => r.id === data?.id);
      if (index === -1) return true;
      if (options.remove === 'soft') {
        rows[index] = { ...rows[index], status: 'deleted' } as T;
      } else {
        rows.splice(index, 1);
      }
      return true;
    };
  }

  return handlers;
}
