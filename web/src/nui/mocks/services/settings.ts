// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceId } from '@mica/shared/devices';
import { deviceOf } from '../perDevice';
import type { MockContext, MockHandler } from '../registry';

/**
 * Every row is one device's (MICA-264), whatever app it belongs to — the real table is keyed
 * per device, and one rule for the whole table is the point. The phone-wide preferences, the
 * Store's install list (`store:installedAddOns`), the add-on grants and each add-on's own
 * storage are all a device's own: an add-on installed on the tablet is on the tablet and not
 * on the phone, as on a real second device.
 *
 * The scoped composite is the key into `mockSettings` and `removedSettings` below; the
 * answer to `settings:getAll` is everything scoped to the asking device.
 */
const scopeOf = (composite: string, device: DeviceId): string => `${device}|${composite}`;

/** The composite back out of a scoped key, or `null` if it is another device's. */
const visibleTo = (scoped: string, device: DeviceId): string | null => {
  const bar = scoped.indexOf('|');
  return scoped.slice(0, bar) === device ? scoped.slice(bar + 1) : null;
};

/**
 * The mock settings table, keyed `<app>:<key>` exactly as the real unique index is, behind
 * the device scope `scopeOf` adds.
 *
 * Module scope, so it survives between `fetchNui` calls within a page but not across a
 * reload — which is the same lifetime the real table has relative to a character session,
 * and enough for an e2e to prove a write reached "the server" rather than only
 * localStorage.
 */
const mockSettings = new Map<string, string>();

/**
 * Every `mica:<app>:<key>` entry `localStorage` held **at the moment this module first
 * evaluated** — a one-time snapshot, not a live read — as `<app>:<key>` → value, the same
 * composite `mockSettings` above uses, so the two merge without a second pass.
 *
 * MICA-287 round 4: `settings:getAll` used to answer from `mockSettings` alone, which
 * starts empty on every load. A browser has no server, so an e2e that seeds `localStorage`
 * before navigating (`web/e2e/support/homeGrid.ts`'s `seedHomeGrid`,
 * `settings-persistence.spec.ts`'s own `seed`, both via `page.addInitScript`, which
 * Playwright guarantees runs before any of the page's own scripts) is standing in for "the
 * server already has this row" — exactly the shape a real character's saved settings
 * arrive in. Answering `[]` while those keys sat right there in `localStorage` meant the
 * character-load sweep in `host/facets/storage.ts` read a genuinely successful, empty
 * answer as "this character has nothing" and deleted every one of them.
 *
 * MICA-287 round 5: reading `Object.keys(localStorage)` **live**, on every call, went too
 * far the other way. `settings:getAll` is also what `onboarding.ts`'s
 * `migrateAppDrawerHintForExistingSaves` calls to decide whether a character already had
 * *some* preference before this hint shipped — and a live read reported keys the phone's
 * own boot had already written to `localStorage` by the time that call fired, not only
 * ones an e2e had seeded before navigation. A fresh install then looked like an existing
 * one and the first-run hint never showed (`defects.spec.ts`'s "the hint sits above the
 * Dock icons" test). A snapshot taken once, here, at module scope, is what "the server's
 * copy as of page load" actually means: this module sits behind a **static** import chain
 * from `fetchNui.ts` (`transport.ts` imports `registry.ts`, whose glob is eager), which
 * every service that can reach the network — `web/src/services/settings.ts` included —
 * imports before it can make a single call, so this line runs during the bundle's
 * initial, synchronous module evaluation, strictly before Svelte schedules the first
 * `onMount` (Shell's included) and therefore before anything the phone's own boot could
 * have written. Anything written *after* this line — the phone's own boot, or a player's
 * actual session — only ever reaches `settings:getAll` through `mockSettings`, via
 * `settings:set`, exactly like the real table.
 *
 * Excludes anything outside the `mica:<app>:<key>` shape (`mica_first_boot_time` and
 * friends) the same way `host/facets/storage.ts`'s own `parseSettingsKey` does — those are
 * device state, never a server row.
 *
 * Every device's starting rows, unscoped (MICA-264): a seed is a spec saying "the server
 * already has this", and a tablet spec seeds `homeGridItems:tablet` exactly as a phone spec
 * seeds `homeGridItems`. What a device writes or removes afterwards is its own.
 */
const initialLocalStorageSettings: [string, string][] = (() => {
  if (typeof localStorage === 'undefined') return [];
  const entries: [string, string][] = [];
  for (const key of Object.keys(localStorage)) {
    const match = /^mica:([^:]+):(.+)$/.exec(key);
    if (!match) continue;
    entries.push([`${match[1]}:${match[2]}`, localStorage.getItem(key) ?? '']);
  }
  return entries;
})();

/**
 * Scoped composites explicitly removed this session, so `settings:remove`/`settings:clearApp`
 * can take a key back out of the *snapshot* above too, not only out of `mockSettings`.
 *
 * Without this, a key seeded at boot and never mutated through `settings:set` had nothing
 * in `mockSettings` for `.delete()` to remove — `initialLocalStorageSettings` is a frozen
 * snapshot, immune to a later local `removeItem` — so it would resurface on the very next
 * `settings:getAll` as though the removal never happened.
 */
const removedSettings = new Set<string>();

export const mocks: Record<string, MockHandler> = {
  /**
   * Settings — the server-backed store, standing in for a real table.
   *
   * Backed by a plain Map rather than a fixture list, and it **mutates**: a mock that
   * answers a read without recording the write makes a broken sync look perfect in
   * `pnpm dev` and in Playwright, which is the exact failure `defineMockCrud` exists to
   * stop for the CRUD path.
   *
   * `mockSettings` starts empty, deliberately — a fresh character has written no
   * preferences of their own this session. But the answer is `mockSettings` merged over
   * `initialLocalStorageSettings` (see that constant's doc for why it is a snapshot, not a
   * live read): that snapshot is what an e2e's `page.addInitScript` seeded to mean "the
   * server already has this row", and every later write — the phone's own boot included —
   * reaches this answer only through `mockSettings`, via `settings:set`, exactly like the
   * real table does.
   */
  'settings:getAll': async (_data?: unknown, context?: MockContext) => {
    const device = deviceOf(context);
    const merged = new Map<string, string>(initialLocalStorageSettings);
    for (const [scoped, value] of mockSettings) {
      const composite = visibleTo(scoped, device);
      if (composite !== null) merged.set(composite, value);
    }
    for (const scoped of removedSettings) {
      const composite = visibleTo(scoped, device);
      if (composite !== null) merged.delete(composite);
    }

    return [...merged.entries()].map(([composite, setting_value], index) => {
      const [app, ...rest] = composite.split(':');
      return {
        id: index + 1,
        citizenid: 'mock_citizenid',
        app,
        setting_key: rest.join(':'),
        setting_value,
        status: 'active' as const,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    });
  },

  'settings:set': async (
    data?: { app?: string; key?: string; value?: string },
    context?: MockContext
  ) => {
    if (!data?.app || !data?.key) return false;
    const scoped = scopeOf(`${data.app}:${data.key}`, deviceOf(context));
    mockSettings.set(scoped, String(data.value ?? ''));
    // A set after a remove un-removes it — the player wrote a new value, so whatever
    // `settings:remove` tombstoned no longer applies.
    removedSettings.delete(scoped);
    return true;
  },

  'settings:remove': async (data?: { app?: string; key?: string }, context?: MockContext) => {
    if (!data?.app || !data?.key) return false;
    const scoped = scopeOf(`${data.app}:${data.key}`, deviceOf(context));
    mockSettings.delete(scoped);
    // The key may only exist in the boot-time snapshot (`initialLocalStorageSettings`),
    // which `.delete()` above cannot reach — it is frozen at module init — so the removal
    // has to be tracked separately or the key would resurface on the next `getAll`.
    removedSettings.add(scoped);
    return true;
  },

  'settings:clearApp': async (data?: { app?: string }, context?: MockContext) => {
    if (!data?.app) return false;
    const device = deviceOf(context);
    const prefix = `${data.app}:`;
    for (const scoped of mockSettings.keys()) {
      if (visibleTo(scoped, device)?.startsWith(prefix)) mockSettings.delete(scoped);
    }
    // Same reason `settings:remove` tombstones one key: a row under this app's prefix may
    // only exist in the frozen boot-time snapshot, which nothing above touches.
    for (const [composite] of initialLocalStorageSettings) {
      if (composite.startsWith(prefix)) removedSettings.add(scopeOf(composite, device));
    }
    return true;
  }
};
