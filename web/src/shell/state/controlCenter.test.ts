// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// jsdom: the toggles' modules reach `services/admin.ts`, which reads `window` at module scope.
/** The in-process facet set, as `dock.test.ts` — a unit test stands in for the shell. */
import '../../host/registerFacets';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn().mockResolvedValue([]),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

import {
  __resetControlCenterRegistryReady,
  brightness,
  controlCenterLayout,
  markControlCenterRegistryReady,
  moveToggle,
  orderedSections,
  orderedToggles,
  registerContributedToggle,
  resetControlCenterLayout,
  sanitizeControlCenterLayout,
  setContributedToggleActive,
  setToggleHidden,
  visibleSections,
  visibleToggles
} from './controlCenter';
import { hydrateSettingsOnCharacterLoad, storage } from '../../host/facets/storage';
import { appRegistryStore } from './registry';

const keys = (list: { key: string }[]) => list.map((t) => t.key);
const BUILTINS = ['cellular', 'bluetooth', 'airplane', 'dnd', 'flashlight'];

const toggle = (id: string, over: Partial<{ active: boolean; onToggle: () => void }> = {}) => ({
  id,
  label: id.toUpperCase(),
  icon: 'star',
  active: false,
  onToggle: () => {},
  ...over
});

describe('control center toggles', () => {
  beforeEach(() => {
    resetControlCenterLayout();
  });

  it('lists the five built-ins in the default order', () => {
    expect(keys(get(orderedToggles))).toEqual(BUILTINS);
  });

  it('moves a toggle one step and stops at the ends', () => {
    moveToggle('flashlight', -1);
    expect(keys(get(orderedToggles))).toEqual([
      'cellular',
      'bluetooth',
      'airplane',
      'flashlight',
      'dnd'
    ]);
    moveToggle('cellular', -1);
    moveToggle('dnd', 1);
    expect(keys(get(orderedToggles))[0]).toBe('cellular');
    expect(keys(get(orderedToggles))[4]).toBe('dnd');
  });

  it('hides a toggle from the grid but keeps it listed for editing', () => {
    setToggleHidden('airplane', true);
    expect(keys(get(visibleToggles))).not.toContain('airplane');
    expect(keys(get(orderedToggles))).toContain('airplane');
    setToggleHidden('airplane', false);
    expect(keys(get(visibleToggles))).toContain('airplane');
  });

  it('repairs a hand-edited layout', () => {
    expect(sanitizeControlCenterLayout(null)).toEqual({ order: [], hidden: [] });
    expect(sanitizeControlCenterLayout({ order: ['a', 'a', 3, ''], hidden: 'nope' })).toEqual({
      order: ['a'],
      hidden: []
    });
  });

  it('shows an unknown saved key as nothing and keeps it saved', () => {
    controlCenterLayout.set({ order: ['ghost:x', 'dnd'], hidden: [] });
    expect(keys(get(orderedToggles))[0]).toBe('dnd');
    expect(get(controlCenterLayout).order).toContain('ghost:x');
  });
});

describe('contributed toggles', () => {
  beforeEach(() => {
    resetControlCenterLayout();
  });

  it('appears after the built-ins, keyed <appId>:<id>, and unregisters', () => {
    const off = registerContributedToggle('acme', toggle('lights'));
    expect(keys(get(orderedToggles))).toEqual([...BUILTINS, 'acme:lights']);
    off();
    expect(keys(get(orderedToggles))).toEqual(BUILTINS);
  });

  it('calls the add-on and reflects setContributedToggleActive', () => {
    const onToggle = vi.fn();
    const off = registerContributedToggle('acme', toggle('lights', { onToggle }));
    const find = () => get(orderedToggles).find((t) => t.key === 'acme:lights')!;
    find().onToggle();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(find().active).toBe(false);
    setContributedToggleActive('acme', 'lights', true);
    expect(find().active).toBe(true);
    setContributedToggleActive('acme', 'missing', true); // ignored, does not throw
    off();
  });

  it('unregisters even after the add-on has changed its state', () => {
    const off = registerContributedToggle('acme', toggle('lights'));
    setContributedToggleActive('acme', 'lights', true);
    off();
    expect(keys(get(orderedToggles))).toEqual(BUILTINS);
  });

  it('hides like a built-in', () => {
    const off = registerContributedToggle('acme', toggle('lights'));
    setToggleHidden('acme:lights', true);
    expect(keys(get(visibleToggles))).not.toContain('acme:lights');
    off();
  });

  it('reorders only within its own app, never crossing into the built-ins', () => {
    const offA = registerContributedToggle('acme', toggle('a'));
    const offB = registerContributedToggle('acme', toggle('b'));
    // Registration order: acme:a, acme:b. One swap within the pair.
    moveToggle('acme:a', 1);
    expect(keys(get(orderedToggles))).toEqual([...BUILTINS, 'acme:b', 'acme:a']);

    // 'acme:b' is now first in its own two-member group — nowhere left to go, and the
    // built-ins are a different section, so this must stay a no-op rather than walk
    // into 'flashlight'.
    moveToggle('acme:b', -1);
    expect(keys(get(orderedToggles))).toEqual([...BUILTINS, 'acme:b', 'acme:a']);

    offA();
    offB();
  });

  it('keeps its saved slot across an unregister and a re-register', () => {
    const off = registerContributedToggle('acme', toggle('lights'));
    moveToggle('acme:lights', -1);
    moveToggle('acme:lights', -1);
    const placed = keys(get(orderedToggles));
    off();
    expect(keys(get(orderedToggles))).toEqual(BUILTINS);
    // Reordering what is left must not lose the absent toggle's slot.
    moveToggle('dnd', -1);
    const off2 = registerContributedToggle('acme', toggle('lights'));
    expect(keys(get(orderedToggles)).indexOf('acme:lights')).toBe(placed.indexOf('acme:lights'));
    off2();
  });

  it('a stale unregister does not remove a newer registration', () => {
    const offOld = registerContributedToggle('acme', toggle('lights'));
    const offNew = registerContributedToggle('acme', toggle('lights'));
    offOld();
    expect(keys(get(orderedToggles))).toContain('acme:lights');
    offNew();
    expect(keys(get(orderedToggles))).not.toContain('acme:lights');
  });
});

describe('sections', () => {
  beforeEach(() => {
    resetControlCenterLayout();
  });

  it('groups the built-ins into one headerless section', () => {
    const sections = get(orderedSections);
    expect(sections).toHaveLength(1);
    expect(sections[0].appId).toBeNull();
    expect(sections[0].appName).toBeNull();
    expect(keys(sections[0].toggles)).toEqual(BUILTINS);
  });

  it('gives a contributing app its own section, headed by its registry name, never interleaved with the built-ins', () => {
    // A real registered app, so the section header reads the same name the launcher does
    // rather than a name this test invents and the component might not actually resolve.
    const appName = get(appRegistryStore).find((a) => a.id === 'contacts')?.name;
    expect(
      appName,
      'contacts must be a registered core app for this test to mean anything'
    ).toBeTruthy();

    const off = registerContributedToggle('contacts', toggle('reminder'));
    const sections = get(orderedSections);
    expect(sections).toHaveLength(2);
    expect(sections[0].appId).toBeNull(); // built-ins first
    expect(keys(sections[1].toggles)).toEqual(['contacts:reminder']);
    expect(sections[1].appId).toBe('contacts');
    expect(sections[1].appName).toBe(appName);
    off();
  });

  it('gives two different contributing apps two different sections', () => {
    const offA = registerContributedToggle('acme', toggle('a'));
    const offB = registerContributedToggle('beta', toggle('b'));
    const sections = get(orderedSections);
    expect(sections.map((s) => s.appId)).toEqual([null, 'acme', 'beta']);
    offA();
    offB();
  });

  it('drops a hidden section from the visible view but keeps it for editing', () => {
    const off = registerContributedToggle('acme', toggle('a'));
    setToggleHidden('acme:a', true);
    expect(get(visibleSections).map((s) => s.appId)).toEqual([null]);
    expect(get(orderedSections).map((s) => s.appId)).toEqual([null, 'acme']);
    off();
  });
});

describe('layout pruning', () => {
  beforeEach(() => {
    resetControlCenterLayout();
    __resetControlCenterRegistryReady();
  });

  // `sanitizeControlCenterLayout` caps a saved array at 64 entries on the way in — a
  // fixture at or past that cap would be truncated before pruning ever ran, proving
  // nothing about the prune itself. These fixtures stay under 64 and at or past
  // `PRUNE_THRESHOLD` (56), the size band pruning actually exists for.

  it('does not prune before the app registry is marked ready (MICA-247 review)', () => {
    // No `markControlCenterRegistryReady()` here — a remote add-on's rehydrate may not
    // have resolved yet, so a key that looks stale this early might not actually be.
    const ghosts = Array.from({ length: 60 }, (_, i) => `never-installed-${i}:x`);
    controlCenterLayout.set({ order: [...ghosts, ...BUILTINS], hidden: [] });
    setToggleHidden('dnd', true);
    setToggleHidden('dnd', false);
    expect(get(controlCenterLayout).order).toEqual(expect.arrayContaining(ghosts));
  });

  it('never prunes a currently-registered toggle, however large the saved list gets', () => {
    const off = registerContributedToggle('acme', toggle('sticks-around'));
    const ghosts = Array.from({ length: 58 }, (_, i) => `gone-${i}:x`);
    controlCenterLayout.set({ order: [...ghosts, 'acme:sticks-around'], hidden: [] });
    markControlCenterRegistryReady();
    // Writing through `setToggleHidden` is what applies the prune.
    setToggleHidden('acme:sticks-around', true);
    setToggleHidden('acme:sticks-around', false);
    expect(get(controlCenterLayout).order).toContain('acme:sticks-around');
    off();
  });

  it('prunes a stale add-on key once the registry is ready and the list is large enough to bother, leaving built-ins alone', () => {
    const ghosts = Array.from({ length: 55 }, (_, i) => `never-installed-${i}:x`);
    controlCenterLayout.set({ order: [...ghosts, ...BUILTINS], hidden: [...ghosts] });
    markControlCenterRegistryReady();
    // Any write applies the prune; hiding a real, present key is a normal one.
    setToggleHidden('dnd', true);
    const layout = get(controlCenterLayout);
    expect(layout.order.some((k) => k.startsWith('never-installed-'))).toBe(false);
    expect(layout.hidden.some((k) => k.startsWith('never-installed-'))).toBe(false);
    expect(layout.order).toEqual(expect.arrayContaining(BUILTINS));
    setToggleHidden('dnd', false);
  });

  it('leaves a short list alone even with a stale key in it', () => {
    controlCenterLayout.set({ order: ['long-gone:x', 'dnd'], hidden: [] });
    setToggleHidden('airplane', true);
    expect(get(controlCenterLayout).order).toContain('long-gone:x');
    setToggleHidden('airplane', false);
  });
});

describe('persistence', () => {
  const settingsStorage = storage('settings');

  it('clamps brightness so the screen cannot be dimmed to black', () => {
    brightness.set(0);
    expect(get(brightness)).toBe(0.2);
    brightness.set(5);
    expect(get(brightness)).toBe(1);
    brightness.set(1);
  });

  it('MICA-287: a character switch replaces the layout with the new character’s', async () => {
    settingsStorage.removeItem('controlCenterLayout');
    serviceMock.fetchSettings.mockResolvedValueOnce([
      {
        app: 'settings',
        setting_key: 'controlCenterLayout',
        setting_value: JSON.stringify({ order: ['dnd'], hidden: ['airplane'] })
      }
    ]);
    await hydrateSettingsOnCharacterLoad();
    expect(get(controlCenterLayout)).toEqual({ order: ['dnd'], hidden: ['airplane'] });

    settingsStorage.removeItem('controlCenterLayout');
    serviceMock.fetchSettings.mockResolvedValueOnce([]);
    await hydrateSettingsOnCharacterLoad();
    expect(get(controlCenterLayout)).toEqual({ order: [], hidden: [] });
  });
});
