// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { detectFramework, FrameworkBridge } from './FrameworkBridge';
import type { FrameworkPlayer } from './framework/runtime';
import { guardNetEvent } from './netGuard';
import { onPlayerLoaded } from './shell';

/**
 * The phone as something a player has to be holding (MICA-229, the first slice of
 * MICA-219).
 *
 * The phone opened for anyone with the keybind, so a server could not make it something you
 * buy, lose or have taken. `mica_phone_item` names an inventory item; while it is set, the
 * phone opens only for a player holding at least one, using the item opens it, and losing the
 * last one closes it the way `SetPhoneEnabled(false)` does. Empty, which is the default, gates
 * nothing, so an existing install is untouched.
 *
 * **The server decides, every time.** The client never says whether it holds the item; it
 * says "look again", and this counts through the inventory and pushes the answer. That is the
 * shape every other net event here has (§2.9): the only thing off the wire is a request, and a
 * modified client that lies about its inventory gets exactly the phone its real inventory
 * earns. What it can do is ask often, which `guardNetEvent`'s limiter bounds.
 *
 * **Standalone ignores the gate**, as the ticket says: with no framework there is no
 * inventory to hold the item in. `mica_standalone` with `mica_phone_item` set is reported
 * once and then behaves as though the item convar were empty.
 *
 * **Fail-open when nothing can count**, said out loud like `removeInventoryItem`. A server
 * with a framework whose inventory exposes none of the three shapes `countInventoryItem`
 * reads would otherwise lock every phone, and the log line is the only symptom either way,
 * so the phone stays open and the line says why.
 */

export const PHONE_ITEM_CONVAR = 'mica_phone_item';

/** An inventory item name: what qb, ox_inventory and ESX all accept, and nothing else. */
const ITEM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const PUSH_EVENT = 'mica:client:shell:phoneItem';
const OPEN_EVENT = 'mica:client:shell:open';

export interface PhoneItemState {
  /** Whether a phone item is required on this server at all. */
  gated: boolean;
  /** Whether this player holds one. Always `true` when not gated. */
  held: boolean;
}

const reported = new Set<string>();

const reportOnce = (key: string, message: string): void => {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(message);
};

/** Test seam, like `__resetStandaloneWarnings`. */
export const __resetPhoneItemWarnings = (): void => {
  reported.clear();
};

/**
 * The item the gate is on, or `null` when there is no gate: the convar is empty, names
 * something no inventory would accept, or this server runs standalone.
 */
export const phoneItemName = (): string | null => {
  const raw = String(GetConvar(PHONE_ITEM_CONVAR, '')).trim();
  if (!raw) return null;
  if (!ITEM_NAME.test(raw)) {
    reportOnce(
      'name',
      `[mica] ${PHONE_ITEM_CONVAR} is set to '${raw}', which is not an item name any ` +
        `inventory here would accept (letters, digits, '_' and '-', up to 64). The phone is ` +
        `not gated on it. Reported once per resource start.`
    );
    return null;
  }
  if (detectFramework() === 'standalone') {
    reportOnce(
      'standalone',
      `[mica] ${PHONE_ITEM_CONVAR} is set to '${raw}', but this server runs standalone and ` +
        `has no inventory to hold it in, so the phone is not gated on it. Reported once per ` +
        `resource start.`
    );
    return null;
  }
  return raw;
};

const heldBy = (player: FrameworkPlayer, item: string): boolean => {
  const count = FrameworkBridge.countItem(player, item);
  if (count === null) {
    reportOnce(
      'count',
      `[mica] ${PHONE_ITEM_CONVAR} is '${item}', but no inventory here can say how many a ` +
        `player holds (ox_inventory's GetItemCount, a qb player's GetItemByName, or an ESX ` +
        `xPlayer's getInventoryItem). The phone is left open rather than locked for everyone. ` +
        `Reported once per resource start.`
    );
    return true;
  }
  return count > 0;
};

/**
 * Count now and tell the client. `null`, and nothing pushed, for a source with no loaded
 * character; `onPlayerLoaded` brings them here once there is one.
 *
 * Pushed even when there is no gate, so the client learns it need not relay inventory
 * changes at all.
 */
export const evaluatePhoneItem = (src: number): PhoneItemState | null => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player) return null;
  const item = phoneItemName();
  const state: PhoneItemState = item
    ? { gated: true, held: heldBy(player, item) }
    : { gated: false, held: true };
  emitNet(PUSH_EVENT, src, state);
  return state;
};

/**
 * Using the item opens the phone. The framework calls this only for an item in that player's
 * own inventory, so holding it is established and the count is not asked again.
 */
const phoneItemUsed = (source: number): void => {
  emitNet(PUSH_EVENT, source, { gated: true, held: true } satisfies PhoneItemState);
  emitNet(OPEN_EVENT, source);
};

const configured = phoneItemName();
if (configured) {
  FrameworkBridge.registerUsableItem(configured, phoneItemUsed);
}

/**
 * "Look again": the client relays an inventory change, or a refused open, and the server
 * counts. Guarded like every other raw net event (`docs/security.md`, category 2), and the
 * request carries nothing, so there is nothing in it to believe.
 */
onNet('mica:server:shell:checkPhoneItem', () => {
  const src = source;
  if (!guardNetEvent('shell', 'checkPhoneItem')) return;
  evaluatePhoneItem(src);
});

onPlayerLoaded('phone-item', (src) => {
  evaluatePhoneItem(src);
});
