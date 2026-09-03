// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Client-side phone state that more than one controller needs to agree on.
 *
 * `isPhoneOpen` used to be a module-local in `client.ts`, which meant the call system
 * force-opening the phone for an incoming call left the flag reading `false`: the next
 * `M` press re-opened an already-open phone, and `toggleFreelook` no-oped because it is
 * guarded on the flag.
 */

let phoneOpen = false;
let typing = false;
let enabled = true;
// MICA-229: what the server last said about the phone item. Ungated until it says
// otherwise, so a server with no gate never has to say so before the first open.
let itemGated = false;
let itemHeld = true;

export const PhoneState = {
  isOpen: (): boolean => phoneOpen,

  /**
   * Pushed to the server on every change so `IsPhoneOpen` has something to answer from
   * (`server/lib/PhoneOpenState.ts`) — there is no way for the server to ask a client
   * synchronously, so it is told rather than queried.
   */
  setOpen: (open: boolean): void => {
    phoneOpen = open;
    TriggerServerEvent('gphone:server:shell:setOpen', open);
  },

  /**
   * Whether the phone may be opened at all. Two things say no independently: `SetPhoneEnabled`
   * (a job confiscating it) and the item gate (MICA-229: `gphone_phone_item` is set and this
   * player holds none). Either alone keeps it shut, so neither can undo the other.
   * `togglePhone` refuses to open while this is false, and either going false while open
   * force-closes it the same way `hideFrame` does.
   */
  isEnabled: (): boolean => enabled && itemHeld,

  setEnabled: (value: boolean): void => {
    enabled = value;
  },

  /** Whether this server gates the phone on an item at all, so inventory changes are worth relaying. */
  isItemGated: (): boolean => itemGated,

  /** The server's last word on the item gate. Ungated means held, whatever `held` says. */
  setItemGate: (gated: boolean, held: boolean): void => {
    itemGated = gated;
    itemHeld = !gated || held;
  },

  /**
   * True while a text field in the NUI has focus, pushed over from the web on
   * `focusin`/`focusout`.
   *
   * The client cannot see DOM focus, so it has to be told. Normally
   * `SetNuiFocus(true, true)` means no key mapping can fire while the phone is open
   * anyway — but freelook turns on `SetNuiFocusKeepInput`, and then typing `M` into a
   * message would insert the character *and* toggle the phone.
   */
  isTyping: (): boolean => typing,

  setTyping: (value: boolean): void => {
    typing = value;
  }
};
