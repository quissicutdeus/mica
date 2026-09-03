// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ALL_DEVICES, DEVICES, type DeviceId } from '@gphone/shared/devices';

/**
 * Client-side device state that more than one controller needs to agree on (MICA-262).
 *
 * This was `PhoneState`, one set of flags for one device. `isPhoneOpen` used to be a
 * module-local in `client.ts` before that, which meant the call system force-opening the
 * phone for an incoming call left the flag reading `false`: the next `M` press re-opened
 * an already-open phone, and `toggleFreelook` no-oped because it is guarded on the flag.
 * The same lesson holds with two devices, so there is one table here and every
 * controller reads it.
 *
 * **One device open at a time is a rule, not a limitation.** NUI focus is process-global
 * and there is one NUI page, so a second frame could never be shown beside the first;
 * `DeviceVisibility.openDevice` closes whatever is up before raising the other, and
 * `openDevice()` below answers with at most one id.
 */
interface DeviceEntry {
  open: boolean;
  /** `SetPhoneEnabled` / `SetDeviceEnabled`: a job confiscating it, an item that jams it. */
  enabled: boolean;
  /**
   * Whether this server has the device on at all — the descriptor's `convars.enable`, as
   * the server last said. A device with no enable convar (the phone) is always on; the
   * tablet starts off until the server pushes otherwise (MICA-263), which is decision 5
   * of MICA-252: `gphone_tablet` defaults off until the tablet has its own identity.
   */
  serverEnabled: boolean;
  /** MICA-229: what the server last said about the item gate. */
  itemGated: boolean;
  itemHeld: boolean;
}

const fresh = (id: DeviceId): DeviceEntry => ({
  open: false,
  enabled: true,
  serverEnabled: DEVICES[id].convars.enable === null,
  // Ungated until the server says otherwise, so a server with no gate never has to say so
  // before the first open.
  itemGated: false,
  itemHeld: true
});

const entries = new Map<DeviceId, DeviceEntry>(ALL_DEVICES.map((id) => [id, fresh(id)]));

const entry = (id: DeviceId): DeviceEntry => entries.get(id) as DeviceEntry;

// Shared across devices: there is one NUI document, so one focused field.
let typing = false;

export const DeviceState = {
  isOpen: (id: DeviceId): boolean => entry(id).open,

  /** Which device is on screen, or `null`. Never more than one — see the module comment. */
  openDevice: (): DeviceId | null => ALL_DEVICES.find((id) => entry(id).open) ?? null,

  isAnyOpen: (): boolean => ALL_DEVICES.some((id) => entry(id).open),

  /**
   * Pushed to the server on every change so `IsPhoneOpen` has something to answer from
   * (`server/lib/PhoneOpenState.ts`) — there is no way for the server to ask a client
   * synchronously, so it is told rather than queried. Carries the device since
   * MICA-262; the server reads the bare boolean it used to get as the phone.
   */
  setOpen: (id: DeviceId, open: boolean): void => {
    entry(id).open = open;
    TriggerServerEvent('gphone:server:shell:setOpen', { device: id, open });
  },

  /**
   * Whether the device may be opened at all. Three things say no independently: the
   * server's enable convar, `SetPhoneEnabled` (a job confiscating it) and the item gate
   * (MICA-229: the item convar is set and this player holds none). Any one keeps it
   * shut, so none can undo another. The toggle refuses to open while this is false, and
   * any of them going false while open force-closes it the same way `hideFrame` does.
   */
  isEnabled: (id: DeviceId): boolean => {
    const e = entry(id);
    return e.enabled && e.serverEnabled && e.itemHeld;
  },

  setEnabled: (id: DeviceId, value: boolean): void => {
    entry(id).enabled = value;
  },

  setServerEnabled: (id: DeviceId, value: boolean): void => {
    entry(id).serverEnabled = value;
  },

  /** Whether this server gates the device on an item at all, so inventory changes are worth relaying. */
  isItemGated: (id: DeviceId): boolean => entry(id).itemGated,

  /** Whether any device is item-gated — what decides if an inventory change is worth a request. */
  isAnyItemGated: (): boolean => ALL_DEVICES.some((id) => entry(id).itemGated),

  /** The server's last word on the item gate. Ungated means held, whatever `held` says. */
  setItemGate: (id: DeviceId, gated: boolean, held: boolean): void => {
    const e = entry(id);
    e.itemGated = gated;
    e.itemHeld = !gated || held;
  },

  /**
   * True while a text field in the NUI has focus, pushed over from the web on
   * `focusin`/`focusout`.
   *
   * The client cannot see DOM focus, so it has to be told. Normally
   * `SetNuiFocus(true, true)` means no key mapping can fire while a device is open
   * anyway — but freelook turns on `SetNuiFocusKeepInput`, and then typing `M` into a
   * message would insert the character *and* toggle the phone.
   */
  isTyping: (): boolean => typing,

  setTyping: (value: boolean): void => {
    typing = value;
  },

  /** Test seam: back to the table as it stands at resource start. */
  __reset: (): void => {
    for (const id of ALL_DEVICES) entries.set(id, fresh(id));
    typing = false;
  }
};
