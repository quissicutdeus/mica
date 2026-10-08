// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-264: the browser mock keeps notes, every settings row and the passcode once per
 * device, read off the generic envelope's `device` the way the server reads it — so e2e can
 * show a tablet's data apart from the phone's, and a request stamped with the wrong device
 * fails in a browser rather than only in game.
 *
 * Through `MockRegistry.handle` with the envelope `fetchNui` sends, not the handlers
 * directly: what is under test is that the device survives `resolveGeneric`. Fresh modules
 * per case, since every table here is module scope (`settings.test.ts` says the same), and a
 * stubbed `localStorage` for the reason that file gives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import type { DeviceId } from '@mica/shared/devices';

function stubLocalStorage(seed: Record<string, string> = {}): void {
  const stub: Record<string, unknown> = {
    getItem: (key: string) => (stub[key] as string) ?? null,
    setItem: (key: string, value: string) => {
      stub[key] = value;
    },
    removeItem: (key: string) => {
      delete stub[key];
    }
  };
  Object.assign(stub, seed);
  vi.stubGlobal('localStorage', stub);
}

/** Built, not quoted, for the reason `settings.test.ts` gives. */
const storageKey = (app: string, key: string) => `mica:${app}:${key}`;

type Handle = (event: string, data?: unknown) => Promise<unknown>;
let handle: Handle;

/** `{ service, action, data }`, with `device` only when one is named — absent is the phone. */
const svc = (service: string, action: string, data?: unknown, device?: DeviceId) =>
  handle(
    GENERIC_SERVICE_ACTION,
    device ? { service, action, data, device } : { service, action, data }
  );

const titles = (rows: unknown) => (rows as { title: string }[]).map((n) => n.title);

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  stubLocalStorage({ [storageKey('settings', 'theme')]: '"dark"' });
  ({
    MockRegistry: { handle }
  } = await import('./registry'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** `defineMockCrud` imitates a round trip with a timer. */
const created = async (promise: Promise<unknown>) => {
  await vi.runAllTimersAsync();
  return promise;
};

describe('the per-device mocks (MICA-264)', () => {
  it('keeps one notes list per device; the tablet starts empty', async () => {
    const phoneNotes = titles(await svc('notes', 'get'));
    expect(phoneNotes.length).toBeGreaterThan(0);
    expect(await svc('notes', 'get', undefined, 'tablet')).toEqual([]);

    await created(svc('notes', 'create', { title: 'Patrol log', content: '' }, 'tablet'));
    expect(titles(await svc('notes', 'get', undefined, 'tablet'))).toEqual(['Patrol log']);
    expect(titles(await svc('notes', 'get', undefined, 'phone'))).toEqual(phoneNotes);
  });

  it('keeps every settings row per device, whichever app it belongs to', async () => {
    await svc('settings', 'set', { app: 'settings', key: 'theme', value: '"light"' }, 'tablet');
    await svc('settings', 'set', { app: 'store', key: 'installedAddOns', value: '["notes"]' });

    const rows = async (device?: DeviceId) =>
      Object.fromEntries(
        (
          (await svc('settings', 'getAll', undefined, device)) as {
            app: string;
            setting_key: string;
            setting_value: string;
          }[]
        ).map((r) => [`${r.app}:${r.setting_key}`, r.setting_value])
      );

    // The seed is every device's starting row; the tablet's own write is the tablet's alone.
    expect((await rows())['settings:theme']).toBe('"dark"');
    expect((await rows('tablet'))['settings:theme']).toBe('"light"');
    // An install made on the phone is the phone's: the tablet keeps installs of its own.
    expect((await rows('phone'))['store:installedAddOns']).toBe('["notes"]');
    expect((await rows('tablet'))['store:installedAddOns']).toBeUndefined();

    await svc('settings', 'remove', { app: 'settings', key: 'theme' }, 'tablet');
    expect((await rows('tablet'))['settings:theme']).toBeUndefined();
    expect((await rows('phone'))['settings:theme']).toBe('"dark"');
  });

  it('keeps one passcode per device', async () => {
    await svc('lockscreen', 'set', { passcode: '1234' }, 'tablet');
    expect(await svc('lockscreen', 'status', undefined, 'tablet')).toEqual({ hasPasscode: true });
    expect(await svc('lockscreen', 'status')).toEqual({ hasPasscode: false });
    expect(await svc('lockscreen', 'check', { passcode: '1234' })).toEqual({ ok: false });
    expect(await svc('lockscreen', 'check', { passcode: '1234' }, 'tablet')).toEqual({ ok: true });
  });
});
