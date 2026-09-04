// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every device the shell can be, declared once (MICA-258, the first slice of MICA-252).
 *
 * The phone used to state its own facts wherever it needed them: its size in
 * `web/src/shell/state/display.ts`, its keybind in `shared/keybinds.ts`, its prop and
 * animation in `client/game/PhoneAnimation.ts`, its item convar in `server/lib/phoneItem.ts`.
 * A tablet is a second device rather than a responsive phone -- the CEF floor is Chromium
 * 103, with no container queries and no viewport units, so every screen is laid out against
 * one fixed frame and drawn at a zoom -- and a second device means every one of those facts
 * needs a second value. This table is where both sets live, so adding a third device is a
 * third entry plus artwork, not a search for the places the second one was welded in.
 *
 * Read by all three targets: `web/` for the frame and launcher, `client/` for the keybind,
 * prop and animation, `server/` for the convars. Nothing here reaches for a runtime, so it
 * can be imported from a Playwright spec as freely as from a Svelte component.
 *
 * **The tablet's prop and animation are a starting point, not a tuning.** They are the
 * pairing most FiveM tablet resources ship, and the offsets and rotation are set in game by
 * MICA-262, which is the first ticket that can see them.
 */

export const ALL_DEVICES = ['phone', 'tablet'] as const;

export type DeviceId = (typeof ALL_DEVICES)[number];

/**
 * The device the shell is until something says otherwise, and the one a payload with no
 * `device` field means -- the client sent a bare `setVisible: true` for years before the
 * tablet existed, and that message still has to open the phone.
 */
export const DEFAULT_DEVICE: DeviceId = 'phone';

export const isDeviceId = (value: unknown): value is DeviceId =>
  typeof value === 'string' && (ALL_DEVICES as readonly string[]).includes(value);

export interface DeviceFrame {
  /** Design CSS pixels: what every screen is laid out against, before the zoom. */
  width: number;
  height: number;
}

export interface DeviceDescriptor {
  id: DeviceId;
  /** Shown in FiveM's Key Bindings menu and micaOS's own Settings. */
  label: string;
  /**
   * The wordmark the launcher paints over the wallpaper.
   *
   * Here rather than in `shell/locales/*.json`, where it used to be one `shell.brand`
   * key: it is a product name, not prose -- `en` and `de` both said `gPhone`, which is
   * what a string that is never actually translated looks like -- and it is a fact
   * about the device, so it belongs beside the other facts about the device. A third
   * entry in this table names itself; it does not also need a locale key adding to
   * every language file.
   */
  brand: string;
  frame: DeviceFrame;
  /** The bezel drawn around the screen, in design px. */
  bezel: number;
  /** The `rounded-*` utility the frame's outer corner takes. */
  cornerRadius: string;
  launcher: {
    columns: number;
    rows: number;
    columnRange: readonly [number, number];
    rowRange: readonly [number, number];
    dockSlots: number;
    drawerColumns: number;
  };
  /** Which pieces of chrome and which phone-only behaviours this device has. */
  chrome: {
    holePunch: boolean;
    hardwareButtons: boolean;
    lockScreen: boolean;
    calls: boolean;
    camera: boolean;
  };
  /** The game-scope action in `shared/keybinds.ts` that opens it, and the command it runs. */
  keybind: {
    id: string;
    command: string;
    defaultKey: string;
  };
  convars: {
    /** A boolean convar that turns the device on, or `null` for a device that is always on. */
    enable: string | null;
    /** The inventory item the device is gated on; empty at runtime means no gate. */
    item: string;
  };
  prop: {
    model: string;
    bone: number;
    offset: readonly [number, number, number];
    rotation: readonly [number, number, number];
  };
  animation: {
    dict: string;
    anim: string;
  };
}

export const DEVICES: Readonly<Record<DeviceId, DeviceDescriptor>> = {
  phone: {
    id: 'phone',
    label: 'Phone',
    brand: 'gPhone',
    // 17:8 exactly; the screen inside the 8px bezel is 384x834, within a hair of the 19.5:9
    // every phone since the iPhone X has used. `display.ts` has the longer reasoning.
    frame: { width: 400, height: 850 },
    bezel: 8,
    cornerRadius: 'rounded-frame-outer',
    launcher: {
      columns: 4,
      rows: 5,
      columnRange: [3, 5],
      rowRange: [4, 6],
      dockSlots: 4,
      drawerColumns: 4
    },
    chrome: { holePunch: true, hardwareButtons: true, lockScreen: true, calls: true, camera: true },
    // `togglePhone` predates the keybind table; players already have it bound.
    keybind: { id: 'openPhone', command: 'togglePhone', defaultKey: 'm' },
    convars: { enable: null, item: 'mica_phone_item' },
    prop: { model: 'prop_npc_phone_02', bone: 28422, offset: [0, 0, 0], rotation: [0, 0, 0] },
    animation: { dict: 'cellphone@', anim: 'cellphone_text_read_base' }
  },
  tablet: {
    id: 'tablet',
    label: 'Tablet',
    brand: 'gTablet',
    // 16:10, the owner's call (MICA-252): wide enough for a two-pane MDT layout, and it
    // fits a 1080p screen at design size with the frame margin to spare.
    frame: { width: 1280, height: 800 },
    bezel: 12,
    cornerRadius: 'rounded-frame-outer-tablet',
    launcher: {
      columns: 8,
      rows: 4,
      columnRange: [6, 10],
      rowRange: [3, 5],
      dockSlots: 6,
      drawerColumns: 8
    },
    // The lock screen follows the passcode row, which is per device only once MICA-264
    // gives a tablet its own identity; calls and the camera are the phone's. The power
    // and volume keys are not: a tablet has them like any other handheld, and without
    // them the only way to put this one down was its keybind.
    chrome: {
      holePunch: false,
      hardwareButtons: true,
      lockScreen: false,
      calls: false,
      camera: false
    },
    keybind: { id: 'openTablet', command: 'toggleTablet', defaultKey: 'F2' },
    convars: { enable: 'mica_tablet', item: 'mica_tablet_item' },
    // Right hand, held flat: the pairing most tablet resources use. Tuned in game by
    // MICA-262; until then these are the numbers to start from, not the answer.
    prop: {
      model: 'prop_cs_tablet',
      bone: 28422,
      offset: [-0.05, 0, 0],
      rotation: [0, 0, 0]
    },
    animation: { dict: 'amb@code_human_in_bus_passenger_idles@female@tablet@base', anim: 'base' }
  }
};
