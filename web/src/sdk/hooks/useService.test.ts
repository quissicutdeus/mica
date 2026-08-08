// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GENERIC_SERVICE_ACTION, parseGenericRequest } from '@shared/rpc';

const nui = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../../nui/fetchNui', () => nui);

import { useService } from './useService';

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

describe('the generic request contract', () => {
  it('accepts a well-formed request', () => {
    expect(parseGenericRequest({ service: 'journal', action: 'get', data: { a: 1 } })).toEqual({
      service: 'journal',
      action: 'get',
      data: { a: 1 }
    });
  });

  it('refuses a segment that could address something other than a gphone service', () => {
    // Both segments are interpolated into an event name. Unvalidated, one could name any
    // event on the bus — `playerDropped`, another resource's — rather than a
    // `gphone:server:*` one.
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
    const { MockRegistry } = await import('../../nui/mocks/registry');

    expect(MockRegistry.has(GENERIC_SERVICE_ACTION)).toBe(true);

    const counts = await MockRegistry.handle(GENERIC_SERVICE_ACTION, {
      service: 'notifications',
      action: 'getUnreadCounts'
    });
    expect(counts).toBeDefined();
  });

  it('answers a malformed request rather than throwing', async () => {
    const { MockRegistry } = await import('../../nui/mocks/registry');
    await expect(MockRegistry.handle(GENERIC_SERVICE_ACTION, { service: 1 })).resolves.toBeNull();
  });
});
