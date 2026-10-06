// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, expectTypeOf, vi, beforeEach, type MockInstance } from 'vitest';
import { get } from 'svelte/store';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import { addonOutput, defineAddonService } from '@mica/shared/addonService';
import { createCrudStore } from './createCrudStore';
import { createPagedStore, type PagedStore } from './createPagedStore';
// The seam the stores send through, stubbed as `createCrudStore.test.ts` stubs it.
import * as fetchNuiModule from './nui/transport';
// The template an author copies: its usage must keep compiling against this surface.
import { notes as templateNotes, type Note } from '../tools/addon-template/src/service';

/**
 * MICA-313: `createCrudStore` and `createPagedStore` typed from an add-on's declaration.
 *
 * Both stores already reached an add-on's server through `{ service: id }`; what they lacked
 * were types. The declaration form adds a front door and nothing behind it, so this file
 * holds two things: that the door sends exactly what the string form sends, and that it
 * refuses at compile time what the server would refuse at run time. The second half is
 * `@ts-expect-error` lines, which `pnpm typecheck:sdk` holds — an unused one is itself an
 * error, so a check that went loose fails there rather than passing silently.
 */

interface Entry {
  id: number;
  title: string;
  mood: 'good' | 'bad';
}

const journal = defineAddonService({
  id: 'journal',
  actions: {
    list: { input: {}, output: addonOutput<Entry[]>() },
    create: {
      input: {
        title: { type: 'string', max: 80 },
        mood: { type: 'enum', values: ['good', 'bad'] }
      },
      output: addonOutput<Entry>()
    },
    edit: {
      input: {
        id: { type: 'integer' },
        title: { type: 'string', max: 80 },
        mood: { type: 'enum', values: ['good', 'bad'] }
      }
    },
    remove: { input: { id: { type: 'integer' } } },
    page: {
      input: {
        cursor: { type: 'integer', optional: true },
        limit: { type: 'integer', optional: true },
        mood: { type: 'enum', values: ['good', 'bad'], optional: true }
      },
      output: addonOutput<{ rows: Entry[]; nextCursor: number | null }>()
    },
    // Each of these is wrong for some role below, on purpose.
    one: { input: {}, output: addonOutput<Entry>() },
    untyped: { input: {} },
    titles: { input: {}, output: addonOutput<string[]>() },
    filtered: {
      input: { mood: { type: 'enum', values: ['good', 'bad'] } },
      output: addonOutput<Entry[]>()
    },
    partial: { input: { id: { type: 'integer' }, title: { type: 'string', max: 80 } } },
    byKey: { input: { key: { type: 'string', max: 9 } } },
    noCursor: { input: {}, output: addonOutput<{ rows: Entry[]; nextCursor: number | null }>() },
    textCursor: {
      input: { cursor: { type: 'string', max: 9, optional: true } },
      output: addonOutput<{ rows: Entry[]; nextCursor: number | null }>()
    }
  }
});

const ENTRY: Entry = { id: 1, title: 'a', mood: 'good' };

let fetchNui: MockInstance<typeof fetchNuiModule.fetchNui>;
beforeEach(() => {
  vi.restoreAllMocks();
  fetchNui = vi.spyOn(fetchNuiModule, 'fetchNui');
});

/** What the stores sent, as `[action, service]` pairs read out of each generic request. */
const sent = () =>
  fetchNui.mock.calls.map(([event, body]) => {
    expect(event).toBe(GENERIC_SERVICE_ACTION);
    const { service, action, data } = body as { service: string; action: string; data: unknown };
    return { service, action, data };
  });

describe('createCrudStore(declaration, …)', () => {
  it("sends the declaration's id as the service, and each declared action by name", async () => {
    const store = createCrudStore(journal, {
      list: 'list',
      create: 'create',
      update: 'edit',
      remove: 'remove'
    });

    fetchNui.mockResolvedValueOnce([ENTRY]);
    await store.load();
    fetchNui.mockResolvedValueOnce({ id: 2, title: 'b', mood: 'bad' });
    await store.add({ title: 'b', mood: 'bad' });
    fetchNui.mockResolvedValueOnce(true);
    await store.update({ ...ENTRY, title: 'a2' });
    fetchNui.mockResolvedValueOnce(true);
    await store.delete(2);

    expect(sent()).toEqual([
      { service: 'journal', action: 'list', data: null },
      { service: 'journal', action: 'create', data: { title: 'b', mood: 'bad' } },
      { service: 'journal', action: 'edit', data: { ...ENTRY, title: 'a2' } },
      { service: 'journal', action: 'remove', data: { id: 2 } }
    ]);
    expect(get(store)).toEqual([{ ...ENTRY, title: 'a2' }]);
  });

  it('is the same store as the string form, options included', async () => {
    // One implementation: the declaration form is the string form with `service` filled in,
    // so its sort, validation and missing-event refusal behave identically.
    const store = createCrudStore(
      journal,
      { list: 'list', create: 'create' },
      {
        sort: (a, b) => b.id - a.id,
        validate: (draft) => {
          if (draft.title === '') throw new Error('A title is required.');
        }
      }
    );
    fetchNui.mockResolvedValueOnce([ENTRY, { id: 5, title: 'e', mood: 'bad' }]);
    await store.load();
    expect(get(store).map((e) => e.id)).toEqual([5, 1]);

    await expect(store.add({ title: '', mood: 'good' })).rejects.toThrow('A title is required.');
    await expect(store.delete(1)).rejects.toThrow('The journal store has no delete event.');
    expect(fetchNui).toHaveBeenCalledTimes(1);
  });

  it('types the row from `list`, and the draft from `create`', () => {
    const store = createCrudStore(journal, { list: 'list', create: 'create', remove: 'remove' });

    expectTypeOf(get(store)).toEqualTypeOf<Entry[]>();
    expectTypeOf(store.add).parameter(0).toEqualTypeOf<{ title: string; mood: 'good' | 'bad' }>();
    expectTypeOf(store.add).returns.toEqualTypeOf<Promise<Entry>>();
    expectTypeOf(store.update).parameter(0).toEqualTypeOf<Entry>();

    // No `create`, so nothing can be added — the call fails to compile instead of throwing.
    const readOnly = createCrudStore(journal, { list: 'list' });
    expectTypeOf(readOnly.add).parameter(0).toEqualTypeOf<never>();
  });

  it('refuses at compile time what the server would refuse at run time', () => {
    // Never called: the point is the compiler's answer, not the store.
    const refusals = () => {
      // @ts-expect-error -- not an action the declaration names
      createCrudStore(journal, { list: 'lst' });
      // @ts-expect-error -- `list` must answer a list, and `one` answers a single row
      createCrudStore(journal, { list: 'one' });
      // @ts-expect-error -- `list` must answer a list, and `untyped` declared no output
      createCrudStore(journal, { list: 'untyped' });
      // @ts-expect-error -- a list of rows with an id, and `titles` answers strings
      createCrudStore(journal, { list: 'titles' });
      // @ts-expect-error -- the store lists with no input, and `filtered` requires `mood`
      createCrudStore(journal, { list: 'filtered' });
      // @ts-expect-error -- `create` must answer the row it created
      createCrudStore(journal, { list: 'list', create: 'untyped' });
      // @ts-expect-error -- not an action the declaration names
      createCrudStore(journal, { list: 'list', create: 'make' });
      // @ts-expect-error -- `update` is sent the whole row, and `partial` lacks `mood`
      createCrudStore(journal, { list: 'list', update: 'partial' });
      // @ts-expect-error -- `remove` is sent `{ id }`, and `byKey` declares no `id`
      createCrudStore(journal, { list: 'list', remove: 'byKey' });
      // @ts-expect-error -- `remove` is sent `{ id }` alone, and `edit` requires more
      createCrudStore(journal, { list: 'list', remove: 'edit' });
      // @ts-expect-error -- the service is the declaration's id, not an option
      createCrudStore(journal, { list: 'list' }, { service: 'contacts' });

      const store = createCrudStore(journal, { list: 'list', create: 'create' });
      // @ts-expect-error -- `titel` is not a field of `create`
      void store.add({ titel: 'x', mood: 'good' });
      // @ts-expect-error -- `mood` is an enum of 'good' | 'bad'
      void store.add({ title: 'x', mood: 'meh' });
      // @ts-expect-error -- `mood` is required by `create`
      void store.add({ title: 'x' });
    };
    expect(refusals).toBeTypeOf('function');
  });

  it("accepts the template's own usage", () => {
    const store = createCrudStore(templateNotes, { list: 'list', create: 'add' });
    expectTypeOf(get(store)).toEqualTypeOf<Note[]>();
    expectTypeOf(store.add).parameter(0).toEqualTypeOf<{ text: string }>();
  });

  it('leaves the string form exactly as it was', () => {
    // Every core caller names its row type and passes free-form event names.
    const store = createCrudStore<Entry>('Entries', { list: 'anything' }, { service: 'x' });
    expectTypeOf(get(store)).toEqualTypeOf<Entry[]>();
    expectTypeOf(store.add).parameter(0).toEqualTypeOf<Omit<Entry, 'id'>>();
  });
});

describe('createPagedStore(declaration, …)', () => {
  it("sends the declaration's id as the service, the action by name, and the cursor back", async () => {
    const store = createPagedStore(journal, 'page', { pageSize: 2 });

    fetchNui.mockResolvedValueOnce({ rows: [{ ...ENTRY, id: 9 }], nextCursor: 9 });
    await store.load({ mood: 'good' });
    fetchNui.mockResolvedValueOnce({ rows: [ENTRY], nextCursor: null });
    expect(await store.loadMore()).toBe(true);

    expect(sent()).toEqual([
      { service: 'journal', action: 'page', data: { mood: 'good', cursor: undefined, limit: 2 } },
      { service: 'journal', action: 'page', data: { mood: 'good', cursor: 9, limit: 2 } }
    ]);
    expect(get(store).map((e) => e.id)).toEqual([9, 1]);
    expect(get(store.hasMore)).toBe(false);
  });

  it('refuses, rather than coerces, a declaration without an action name', () => {
    // A type error already; this is the run-time answer for a caller that cast past it.
    const call = createPagedStore as (...args: unknown[]) => unknown;
    expect(() => call(journal, { pageSize: 1 })).toThrow(
      "createPagedStore('journal'): the declaration form takes the action name second."
    );
    expect(fetchNui).not.toHaveBeenCalled();
  });

  it('types the row from the page, whether paged or a bare list', () => {
    expectTypeOf(createPagedStore(journal, 'page')).toEqualTypeOf<PagedStore<Entry>>();
    expectTypeOf(createPagedStore(journal, 'list')).toEqualTypeOf<PagedStore<Entry>>();
  });

  it('refuses at compile time what the server would refuse at run time', () => {
    const refusals = () => {
      // @ts-expect-error -- not an action the declaration names
      createPagedStore(journal, 'pg');
      // @ts-expect-error -- must answer a page or a list, and `one` answers a single row
      createPagedStore(journal, 'one');
      // @ts-expect-error -- rows with an id, and `titles` answers strings
      createPagedStore(journal, 'titles');
      // @ts-expect-error -- the store sends `nextCursor` back as `cursor`, undeclared here
      createPagedStore(journal, 'noCursor');
      // @ts-expect-error -- `nextCursor` is a number, and `textCursor`'s cursor a string
      createPagedStore(journal, 'textCursor');
      // @ts-expect-error -- `pageSize` is sent as `limit`, which `list` does not declare
      createPagedStore(journal, 'list', { pageSize: 20 });
      // @ts-expect-error -- the service is the declaration's id, not an option
      createPagedStore(journal, 'page', { service: 'contacts' });
    };
    expect(refusals).toBeTypeOf('function');
  });

  it('leaves the string and reader forms exactly as they were', () => {
    expectTypeOf(createPagedStore<Entry>('feed', { service: 'x', pageSize: 3 })).toEqualTypeOf<
      PagedStore<Entry>
    >();
    const reader = (_payload: Record<string, unknown>) => Promise.resolve([ENTRY]);
    expectTypeOf(createPagedStore(reader)).toEqualTypeOf<PagedStore<Entry>>();
  });
});
