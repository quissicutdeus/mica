// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PhoneState } from '../lib/PhoneState';

/**
 * Relays an inventory change to the server as "look again" (MICA-229).
 *
 * The server counts the phone item and pushes the answer (`server/lib/phoneItem.ts`); nothing
 * here says what the player holds. What this knows is *when* to ask: each inventory raises an
 * event on the client when its contents move, and `onNet` catches a local `TriggerEvent` as
 * well as a networked one, so one registration serves ox_inventory's local `itemCount`,
 * qb-core's local `SetPlayerData` and ESX's networked add/remove pair. An event a server never
 * raises costs nothing to listen for.
 *
 * Coalesced, because qb-core raises `SetPlayerData` on a change to anything at all, so a
 * burst is one request rather than a dozen; the server's own limiter is the backstop.
 * Nothing is sent while the server has said there is no gate.
 */
const INVENTORY_EVENTS = [
  'ox_inventory:itemCount',
  'QBCore:Player:SetPlayerData',
  'esx:addInventoryItem',
  'esx:removeInventoryItem'
];

const COALESCE_MS = 750;

let pending: ReturnType<typeof setTimeout> | null = null;

export const requestPhoneItemCheck = (): void => {
  if (!PhoneState.isItemGated() || pending) return;
  pending = setTimeout(() => {
    pending = null;
    TriggerServerEvent('gphone:server:shell:checkPhoneItem');
  }, COALESCE_MS);
};

for (const event of INVENTORY_EVENTS) {
  onNet(event, () => requestPhoneItemCheck());
}
