// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable, type Readable } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { airplaneModeEnabled, toggleAirplaneMode } from './airplane';
import { bluetoothEnabled, toggleBluetooth } from './bluetooth';
import { flashlightEnabled, toggleFlashlight } from './flashlight';
import { dndEnabled } from './notificationPolicy';
import { cellServiceEnabled, toggleCellService } from './signal';
import { registerHandler } from './keybinds';
import { appRegistryStore } from './registry';

/**
 * The control center (MICA-247): the switches, brightness, volume and the music tray, on a
 * surface of their own instead of a hardcoded row at the top of the notification shade.
 *
 * ## The surface
 *
 * A second sheet beside the shade, opened by pulling down from the *right* part of the
 * status bar (the shade keeps the left). It is not the shade's second page: the shade's
 * close-drag, its scroll-edge rule and its `Archive` toggle all assume one list, and a
 * horizontal page swipe would fight `SwipeableRow`'s own sideways gesture on every
 * notification. A sibling sheet reuses `createSheetClose`/`createSheetOpen` unchanged and
 * shares nothing with the list.
 *
 * ## The layout is persisted per phone
 *
 * `settings/controlCenterLayout`, through `usePersisted`, so it rides the per-character
 * settings sync and is swept and re-read on a character switch like every other setting.
 * A key is in `order` when the player has placed it and in `hidden` when they have hidden
 * it. Neither is ever pruned when a toggle is absent: an add-on toggle that is uninstalled
 * (or whose frame is torn down and comes back) returns to the slot it was in.
 */

// --- Contributed toggles -------------------------------------------------------------------

export type ContributedToggle = {
  id: string;
  label: string;
  icon: string;
  active: boolean;
  onToggle: () => void;
};

interface ContributedEntry {
  appId: string;
  /** Identity of one registration; survives `setContributedToggleActive`'s copy. */
  token: object;
  toggle: ContributedToggle;
}

/** Keyed `<appId>:<id>`. Insertion order is registration order, which is the default order. */
const contributed = writable<Map<string, ContributedEntry>>(new Map());

const contributedKey = (appId: string, id: string): string => `${appId}:${id}`;

/**
 * Add a toggle from an add-on. Returns the unregister, which removes only *this*
 * registration: a re-register under the same key (a reloaded frame) is not undone by the
 * old frame's late cleanup.
 */
export function registerContributedToggle(appId: string, toggle: ContributedToggle): () => void {
  const key = contributedKey(appId, toggle.id);
  const token = {};
  const entry: ContributedEntry = { appId, token, toggle: { ...toggle } };
  contributed.update((map) => {
    const next = new Map(map);
    next.set(key, entry);
    return next;
  });
  return () => {
    contributed.update((map) => {
      if (map.get(key)?.token !== token) return map;
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  };
}

/** The add-on says its state changed; a key that is not registered is ignored. */
export function setContributedToggleActive(appId: string, id: string, active: boolean): void {
  const key = contributedKey(appId, id);
  contributed.update((map) => {
    const entry = map.get(key);
    if (!entry || entry.toggle.active === active) return map;
    const next = new Map(map);
    next.set(key, { ...entry, toggle: { ...entry.toggle, active } });
    return next;
  });
}

// --- The toggles, as one list --------------------------------------------------------------

export interface ControlCenterToggle {
  key: string;
  builtin: boolean;
  /** `null` for a built-in; the owning app's id for a contributed toggle. Sections and
   *  scoped reordering (below) are built from this, not from parsing `key`. */
  appId: string | null;
  /** Contributed only — the add-on's own label and icon name. */
  label?: string;
  icon?: string;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}

/** Every toggle that exists right now, unordered and unhidden: built-ins, then add-ons. */
const allToggles: Readable<ControlCenterToggle[]> = derived(
  [
    cellServiceEnabled,
    bluetoothEnabled,
    airplaneModeEnabled,
    dndEnabled,
    flashlightEnabled,
    contributed
  ],
  ([$cell, $bt, $airplane, $dnd, $flash, $contributed]) => [
    // Airplane mode locks the two radios off, so their tiles are inert while it is on.
    {
      key: 'cellular',
      builtin: true,
      appId: null,
      active: $cell,
      disabled: $airplane,
      onToggle: toggleCellService
    },
    {
      key: 'bluetooth',
      builtin: true,
      appId: null,
      active: $bt,
      disabled: $airplane,
      onToggle: toggleBluetooth
    },
    {
      key: 'airplane',
      builtin: true,
      appId: null,
      active: $airplane,
      disabled: false,
      onToggle: toggleAirplaneMode
    },
    {
      key: 'dnd',
      builtin: true,
      appId: null,
      active: $dnd,
      disabled: false,
      onToggle: () => dndEnabled.update((on) => !on)
    },
    {
      key: 'flashlight',
      builtin: true,
      appId: null,
      active: $flash,
      disabled: false,
      onToggle: toggleFlashlight
    },
    ...[...$contributed.entries()].map(([key, { appId, toggle }]): ControlCenterToggle => ({
      key,
      builtin: false,
      appId,
      label: toggle.label,
      icon: toggle.icon,
      active: toggle.active,
      disabled: false,
      onToggle: () => toggle.onToggle()
    }))
  ]
);

// --- Layout --------------------------------------------------------------------------------

export interface ControlCenterLayout {
  order: string[];
  hidden: string[];
}

const LAYOUT_MAX = 64;

const sanitizeKeys = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 128) seen.add(item);
    if (seen.size >= LAYOUT_MAX) break;
  }
  return [...seen];
};

export const sanitizeControlCenterLayout = (value: unknown): ControlCenterLayout => {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ControlCenterLayout>;
  return { order: sanitizeKeys(raw.order), hidden: sanitizeKeys(raw.hidden) };
};

export const controlCenterLayout = usePersisted<ControlCenterLayout>(
  'settings',
  'controlCenterLayout',
  { order: [], hidden: [] },
  { sanitize: sanitizeControlCenterLayout }
);

/**
 * Saved order first — including keys not present at the moment, which stay where they were
 * — then whatever the player has never placed, in default order.
 */
const fullOrder = (layout: ControlCenterLayout, present: readonly string[]): string[] => {
  const out = [...layout.order];
  for (const key of present) if (!out.includes(key)) out.push(key);
  return out;
};

/** Every toggle that exists, in the player's order, hidden ones included (edit mode). */
export const orderedToggles: Readable<ControlCenterToggle[]> = derived(
  [allToggles, controlCenterLayout],
  ([$all, $layout]) => {
    const byKey = new Map($all.map((t) => [t.key, t]));
    return fullOrder(
      $layout,
      $all.map((t) => t.key)
    )
      .map((key) => byKey.get(key))
      .filter((t): t is ControlCenterToggle => t !== undefined);
  }
);

/** What the tile grid shows outside edit mode. */
export const visibleToggles: Readable<ControlCenterToggle[]> = derived(
  [orderedToggles, controlCenterLayout],
  ([$ordered, $layout]) => $ordered.filter((t) => !$layout.hidden.includes(t.key))
);

/**
 * Only relevant once the saved lists are large enough that a stale add-on key is worth
 * the lookup — a handful of entries costs nothing to keep around forever. A key still in
 * `contributed` right now is never dropped, even if `appRegistryStore` disagrees: being
 * registered *is* evidence the toggle exists, and an app can be mid-install/mid-teardown
 * (briefly out of the registry) while its frame is still very much alive.
 */
const PRUNE_THRESHOLD = LAYOUT_MAX - 8;

/**
 * Whether the app registry has finished its own boot-time settling — specifically, the
 * remote add-on catalog has been re-verified (`loadRemoteAppConfig`, called once from
 * `Shell.svelte`'s `onMount`), so `appRegistryStore` reflects every currently-installed
 * add-on rather than only the ones resolved synchronously at module load (the bundled
 * apps). Pruning before this flips would read a genuinely-installed remote add-on as
 * "not installed" purely because its rehydrate had not resolved yet, and drop its saved
 * slot for a reason that has nothing to do with the player's own choice. Starts `false`;
 * a fresh module load (a real boot, or a test file that never calls the marker) prunes
 * nothing until something says the registry is actually settled.
 */
export const controlCenterRegistryReady = writable<boolean>(false);

export function markControlCenterRegistryReady(): void {
  controlCenterRegistryReady.set(true);
}

/** Test-only: the flag is otherwise monotonic — a real boot only ever settles once. */
export function __resetControlCenterRegistryReady(): void {
  controlCenterRegistryReady.set(false);
}

const appIdOf = (key: string): string | null => {
  const i = key.indexOf(':');
  return i === -1 ? null : key.slice(0, i);
};

const pruneUninstalled = (keys: readonly string[]): string[] => {
  if (keys.length < PRUNE_THRESHOLD) return [...keys];
  if (!get(controlCenterRegistryReady)) return [...keys];
  const installed = new Set(get(appRegistryStore).map((app) => app.id));
  const registered = get(contributed);
  return keys.filter((key) => {
    const appId = appIdOf(key);
    if (appId === null) return true; // a built-in
    if (registered.has(key)) return true; // a live registration, kept regardless
    return installed.has(appId);
  });
};

/** Sweeps both saved arrays — either write is a chance to drop what the other left stale. */
const pruneLayout = (layout: ControlCenterLayout): ControlCenterLayout => ({
  order: pruneUninstalled(layout.order),
  hidden: pruneUninstalled(layout.hidden)
});

export function setToggleHidden(key: string, hidden: boolean): void {
  controlCenterLayout.update((layout) => {
    const rest = layout.hidden.filter((k) => k !== key);
    return pruneLayout({ ...layout, hidden: hidden ? [...rest, key] : rest });
  });
}

/**
 * Move a toggle one step **within its own section** — the built-ins among themselves, or
 * one add-on's toggles among themselves — never across into another app's or the
 * built-ins' territory (MICA-247 review: sections must not interleave). Positions of
 * absent toggles are untouched: the swap is made between the two present keys inside the
 * full saved order, so an uninstalled add-on's slot survives a reorder of what is left.
 */
export function moveToggle(key: string, delta: -1 | 1): void {
  const list = get(orderedToggles);
  const target = list.find((t) => t.key === key);
  if (!target) return;
  const groupKeys = list.filter((t) => t.appId === target.appId).map((t) => t.key);
  const from = groupKeys.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= groupKeys.length) return;
  const other = groupKeys[to];
  const layout = get(controlCenterLayout);
  const order = pruneUninstalled(
    fullOrder(
      layout,
      list.map((t) => t.key)
    )
  );
  const a = order.indexOf(key);
  const b = order.indexOf(other);
  [order[a], order[b]] = [order[b], order[a]];
  controlCenterLayout.set(pruneLayout({ ...layout, order }));
}

export function resetControlCenterLayout(): void {
  controlCenterLayout.set({ order: [], hidden: [] });
}

// --- Sections (never interleaved: built-ins, then one section per contributing app) --------

export interface ControlCenterSection {
  /** `null` for the built-ins. */
  appId: string | null;
  /** The owning app's display name; `null` for the built-ins' section, which has no header. */
  appName: string | null;
  toggles: ControlCenterToggle[];
}

const sectionsOf = (
  list: readonly ControlCenterToggle[],
  names: ReadonlyMap<string, string>
): ControlCenterSection[] => {
  const sections: ControlCenterSection[] = [];
  const byAppId = new Map<string, ControlCenterSection>();
  let builtins: ControlCenterSection | null = null;
  for (const toggle of list) {
    if (toggle.appId === null) {
      if (!builtins) {
        builtins = { appId: null, appName: null, toggles: [] };
        sections.push(builtins);
      }
      builtins.toggles.push(toggle);
      continue;
    }
    let section = byAppId.get(toggle.appId);
    if (!section) {
      section = {
        appId: toggle.appId,
        appName: names.get(toggle.appId) ?? toggle.appId,
        toggles: []
      };
      byAppId.set(toggle.appId, section);
      sections.push(section);
    }
    section.toggles.push(toggle);
  }
  return sections;
};

const appNames: Readable<ReadonlyMap<string, string>> = derived(
  appRegistryStore,
  ($registry) => new Map($registry.map((app) => [app.id, app.name]))
);

/** Grouped, edit-mode view — every toggle, hidden ones included. */
export const orderedSections: Readable<ControlCenterSection[]> = derived(
  [orderedToggles, appNames],
  ([$list, $names]) => sectionsOf($list, $names)
);

/** Grouped view of what the tile grid actually shows. */
export const visibleSections: Readable<ControlCenterSection[]> = derived(
  [visibleToggles, appNames],
  ([$list, $names]) => sectionsOf($list, $names)
);

// --- Brightness ----------------------------------------------------------------------------

export const BRIGHTNESS_MIN = 0.2;

/**
 * Screen brightness, 0.2..1. There was no brightness anywhere in the phone before this, so
 * it is a dimming layer over the screen (`ControlCenter.svelte` draws it), not a hardware
 * value. Floored so the screen cannot be dimmed to a black rectangle with no way to see the
 * slider that would undo it.
 */
export const brightness = usePersisted<number>('settings', 'brightness', 1, {
  sanitize: (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(BRIGHTNESS_MIN, n)) : 1;
  }
});

// --- Sheet state ---------------------------------------------------------------------------

export const isControlCenterOpen = writable<boolean>(false);
export const controlCenterDragProgress = writable<number>(0);
export const controlCenterDragPhase = writable<'idle' | 'dragging' | 'settling'>('idle');

let unregisterBack: (() => void) | null = null;

export function openControlCenter(): void {
  if (get(isControlCenterOpen)) return;
  isControlCenterOpen.set(true);
  if (!unregisterBack) unregisterBack = registerHandler('back', () => closeControlCenter());
}

export function closeControlCenter(): void {
  isControlCenterOpen.set(false);
  if (unregisterBack) {
    unregisterBack();
    unregisterBack = null;
  }
}
