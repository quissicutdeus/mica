// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import { GENERIC_SERVICE_ACTION, parseGenericRequest } from '@mica/shared/rpc';

const nui = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../../web/src/nui/fetchNui', () => nui);

import { useService } from './useService';
import { addonOutput, defineAddonService } from '@mica/shared/addonService';
import { service } from '../../web/src/host/facets/service';
import { registerFacet } from './current';

/**
 * The door an add-on can actually walk through.
 *
 * Every other data hook is core code named after an app, backed by a store in core and a
 * row per action in `shared/routes.ts` — none of which an app installed from the Store can
 * add. That is what made the add-on path support UI-only apps, and what
 * `coreBoundary.test.ts` measures the cost of.
 */
beforeEach(() => {
  vi.clearAllMocks();
  nui.fetchNui.mockResolvedValue(undefined);
});

describe('useService', () => {
  it('sends one generic action carrying the service and the action', async () => {
    // The point: core never learns this service exists. `journal` appears in no route
    // table, no barrel and no allowlist.
    await useService('journal').call('get', { limit: 10 });

    expect(nui.fetchNui).toHaveBeenCalledWith(
      GENERIC_SERVICE_ACTION,
      { service: 'journal', action: 'get', data: { limit: 10 } },
      undefined
    );
  });

  it('passes a default through, so a missing server half degrades rather than throws', async () => {
    nui.fetchNui.mockResolvedValue([]);
    await useService('journal').call('get', undefined, []);

    expect(nui.fetchNui).toHaveBeenCalledWith(GENERIC_SERVICE_ACTION, expect.anything(), {
      defaultValue: []
    });
  });

  it('omits the default entirely when none is given', async () => {
    // Not `{ defaultValue: undefined }`: `fetchNui` decides whether to swallow a failure
    // by whether the key is present, so passing it always would silence every write.
    await useService('journal').call('create', { title: 'x' });
    expect(nui.fetchNui.mock.calls[0][2]).toBeUndefined();
  });
});

/**
 * MICA-308: the declaration form. The object an add-on's resource hands
 * `exports.mica:RegisterService` is the one its UI types its calls from, so a renamed action
 * or a misspelt field is a compile error in the add-on rather than an `invalid_args` toast.
 */
interface Entry {
  id: number;
  title: string;
}

const journal = defineAddonService({
  id: 'journal',
  actions: {
    list: { input: {}, output: addonOutput<Entry[]>() },
    create: {
      input: {
        title: { type: 'string', max: 80 },
        mood: { type: 'enum', values: ['good', 'bad'], optional: true }
      },
      output: addonOutput<Entry>()
    },
    remove: { input: { id: { type: 'integer', min: 1 } } }
  }
});

describe('useService(declaration)', () => {
  it('sends exactly what the string form sends, under the declaration id', async () => {
    // The declaration is a type-level convenience, not a second door: the wire request
    // is byte-for-byte the one `useService('journal')` produces.
    await useService(journal).call('create', { title: 'x' });
    await useService('journal').call('create', { title: 'x' });

    expect(nui.fetchNui).toHaveBeenCalledTimes(2);
    expect(nui.fetchNui.mock.calls[0]).toEqual(nui.fetchNui.mock.calls[1]);
    expect(nui.fetchNui.mock.calls[0]).toEqual([
      GENERIC_SERVICE_ACTION,
      { service: 'journal', action: 'create', data: { title: 'x' } },
      undefined
    ]);
  });

  it('asks the same service facet for declaration.id', () => {
    // Same facet, same argument: whatever the shell checks about `service('journal')` —
    // `serviceAllowed`, the permission row — it checks here, with nothing to tell the two
    // forms apart. Swapped through the registry rather than spied on the module, because a
    // hook reaches a facet by name through `current.ts`, never by import.
    const asked: unknown[][] = [];
    registerFacet('service', (...args: Parameters<typeof service>) => {
      asked.push(args);
      return service(...args);
    });
    try {
      useService(journal);
      useService('journal');
      useService(defineAddonService({ id: 'journal_extra', actions: { a: { input: {} } } }));
    } finally {
      registerFacet('service', service);
    }
    expect(asked).toEqual([['journal'], ['journal'], ['journal_extra']]);
  });

  it('passes a default through, as the string form does', async () => {
    nui.fetchNui.mockResolvedValue([]);
    await useService(journal).call('list', {}, []);
    expect(nui.fetchNui).toHaveBeenCalledWith(
      GENERIC_SERVICE_ACTION,
      { service: 'journal', action: 'list', data: {} },
      { defaultValue: [] }
    );
  });

  it('types the call from the declaration', async () => {
    const svc = useService(journal);

    // The answer flows from `addonOutput<T>()`; an action that declared none is `unknown`.
    expectTypeOf(svc.call('list')).toEqualTypeOf<Promise<Entry[]>>();
    expectTypeOf(svc.call('create', { title: 't' })).toEqualTypeOf<Promise<Entry>>();
    expectTypeOf(svc.call('remove', { id: 1 })).toEqualTypeOf<Promise<unknown>>();
    expectTypeOf(svc.id).toEqualTypeOf<'journal'>();

    // `list` takes nothing, so its input may be left out; `create` requires `title`.
    // (Called rather than `toBeCallableWith`, which cannot see through a generic method.)
    await svc.call('list');
    await svc.call('create', { title: 't', mood: 'good' });

    // Each of these is a compile error, which `pnpm typecheck:sdk` holds: an unused
    // `@ts-expect-error` is itself an error, so a type that went loose fails there.
    // @ts-expect-error -- not an action the declaration names
    await svc.call('lst');
    // @ts-expect-error -- `titel` is not a field of `create`
    await svc.call('create', { titel: 't' });
    // @ts-expect-error -- an undeclared field beside a valid one, which the server would refuse
    await svc.call('create', { title: 't', extra: 1 });
    // @ts-expect-error -- `title` is a string field
    await svc.call('create', { title: 3 });
    // @ts-expect-error -- `mood` is an enum of 'good' | 'bad'
    await svc.call('create', { title: 't', mood: 'meh' });
    // @ts-expect-error -- `create` has a required field, so its input cannot be left out
    await svc.call('create');
    // @ts-expect-error -- a default must be the declared answer type
    await svc.call('list', {}, 'not a list');
  });

  it('leaves the string form untyped, exactly as before', () => {
    // Every existing caller passes a string and names its own answer type; the overload
    // must not have narrowed that to a declaration's names.
    const svc = useService('journal');
    expectTypeOf(svc.id).toEqualTypeOf<string>();
    expectTypeOf(svc.call<Entry[]>('anything', { free: 'form' }, [])).toEqualTypeOf<
      Promise<Entry[]>
    >();
  });
});

describe('the generic request contract', () => {
  it('accepts a well-formed request', () => {
    expect(parseGenericRequest({ service: 'journal', action: 'get', data: { a: 1 } })).toEqual({
      service: 'journal',
      action: 'get',
      data: { a: 1 }
    });
  });

  it('accepts a camel-cased action, which is how the server names most of its own', () => {
    expect(parseGenericRequest({ service: 'media', action: 'shareLocation', data: {} })).toEqual({
      service: 'media',
      action: 'shareLocation',
      data: {}
    });
  });

  it('refuses a segment that could address something other than a mica service', () => {
    // Both segments are interpolated into an event name. Unvalidated, one could name any
    // event on the bus — `playerDropped`, another resource's — rather than a
    // `mica:server:*` one.
    for (const bad of [
      { service: 'jour:nal', action: 'get' },
      { service: 'journal', action: 'get:extra' },
      { service: '../x', action: 'get' },
      { service: 'Journal', action: 'get' },
      { service: '', action: 'get' },
      { service: 'journal', action: '' },
      { service: 'journal' },
      null,
      'journal:get'
    ]) {
      expect(parseGenericRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the browser mock answers a generic call', () => {
  it('dispatches through to the action the fixtures already know', async () => {
    // Without this the generic path is dead in `pnpm dev` and in Playwright — the exact
    // failure §8 says a missing mock always is, and the one that makes a feature look
    // finished while doing nothing in game.
    const { MockRegistry } = await import('../../web/src/nui/mocks/registry');

    expect(MockRegistry.has(GENERIC_SERVICE_ACTION)).toBe(true);

    const counts = await MockRegistry.handle(GENERIC_SERVICE_ACTION, {
      service: 'notifications',
      action: 'getUnreadCounts'
    });
    expect(counts).toBeDefined();
  });

  it('answers a malformed request rather than throwing', async () => {
    const { MockRegistry } = await import('../../web/src/nui/mocks/registry');
    await expect(MockRegistry.handle(GENERIC_SERVICE_ACTION, { service: 1 })).resolves.toBeNull();
  });
});
