// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ALL_DEVICES, type DeviceId } from '@mica/shared/devices';
import { detectFramework, FrameworkBridge } from './FrameworkBridge';
import type { FrameworkPlayer } from './framework/runtime';
import { guardNetEvent, noInput } from './netGuard';
import { onPlayerLoaded, pushRehydrate } from './shell';

/**
 * Each device as something a player has to be holding, and the tablet as something a server
 * has to switch on (MICA-229 for the phone, MICA-263 for every device in `shared/devices.ts`).
 *
 * The phone opened for anyone with the keybind, so a server could not make it something you
 * buy, lose or have taken. A device's item convar (`mica_phone_item`, `mica_tablet_item`)
 * names an inventory item; while it is set, that device opens only for a player holding at
 * least one, using the item opens it, and losing the last one closes it the way
 * `SetPhoneEnabled(false)` does. Empty, which is the default, gates nothing, so an existing
 * install is untouched. The two gates are independent: a tablet item says nothing about the
 * phone, and the reverse.
 *
 * **The tablet is off unless `mica_tablet` turns it on** (MICA-252, decision 5): it has no
 * identity of its own until MICA-264, so a server gets it only by asking. Off means no usable
 * item is registered for it, `shell:capabilities` leaves it out of `devices`, and every push
 * tells the client it is off. The phone has no enable convar and is always on.
 *
 * **The server decides, every time.** The client never says whether it holds an item; it
 * says "look again", and this counts through the inventory and pushes the answer, one push per
 * device. That is the shape every other net event here has (§2.9): the only thing off the wire
 * is a request, and a modified client that lies about its inventory gets exactly the devices
 * its real inventory earns. What it can do is ask often, which `guardNetEvent`'s limiter
 * bounds.
 *
 * **Standalone ignores every item gate**, as MICA-229 says: with no framework there is no
 * inventory to hold an item in. An item convar set on a standalone server is reported once and
 * then behaves as though it were empty. `mica_tablet` is not an item gate and is honoured
 * there like anywhere else.
 *
 * **Fail-open when nothing can count**, said out loud like `removeInventoryItem`. A server
 * with a framework whose inventory exposes none of the three shapes `countInventoryItem`
 * reads would otherwise lock every device, and the log line is the only symptom either way,
 * so the device stays open and the line says why.
 *
 * **Everything MICA-219 built on the item is the phone's alone.** Phone ids, the active slot
 * (`lastUsedPhoneSlot`), the phone-state subscribers and the rehydrate on a phone switch are
 * all reached only from the phone's paths below. The tablet has no identity until MICA-264,
 * so using one opens it and does nothing else.
 */

export const PHONE_ITEM_CONVAR = 'mica_phone_item';
export const TABLET_ITEM_CONVAR = 'mica_tablet_item';
export const TABLET_ENABLE_CONVAR = 'mica_tablet';

/**
 * Every convar is read through a literal call per name rather than through the descriptor,
 * because `convars.test.ts` reads the name at the call site to hold the README to it. Keyed
 * by `DeviceId`, so a third device will not compile until it has its entries; `deviceItem.test`
 * holds each name to the one `shared/devices.ts` declares.
 */
const readItemConvar: Record<DeviceId, () => string> = {
  phone: () => String(GetConvar(PHONE_ITEM_CONVAR, '')),
  tablet: () => String(GetConvar(TABLET_ITEM_CONVAR, ''))
};

const readEnableConvar: Record<DeviceId, (() => string) | null> = {
  phone: null,
  tablet: () => String(GetConvar(TABLET_ENABLE_CONVAR, 'false'))
};

/** The convar names, for the tests that hold them to `shared/devices.ts`. */
export const DEVICE_CONVARS: Readonly<Record<DeviceId, { enable: string | null; item: string }>> = {
  phone: { enable: null, item: PHONE_ITEM_CONVAR },
  tablet: { enable: TABLET_ENABLE_CONVAR, item: TABLET_ITEM_CONVAR }
};

/** `mica_standalone`'s spelling of "on" (`framework/standalone.ts`), for the same reason. */
const ON = new Set(['1', 'true', 'yes', 'on', 'enabled']);

/** An inventory item name: what qb, ox_inventory and ESX all accept, and nothing else. */
const ITEM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The push the client reads (`client/services/Shell.ts`). It keeps the phone's name: the
 * client has listened for `{ device, gated, held }` on it since MICA-262, and a bare
 * `{ gated, held }` there still means the phone.
 */
const PUSH_EVENT = 'mica:client:shell:phoneItem';
/** The enable convar, for a device that has one (`DeviceState.setServerEnabled`). */
const SERVER_ENABLED_EVENT = 'mica:client:shell:setServerEnabled';
const OPEN_EVENT = 'mica:client:shell:open';

export interface PhoneItemState {
  /** Whether a phone item is required on this server at all. */
  gated: boolean;
  /** Whether this player holds one. Always `true` when not gated. */
  held: boolean;
}

/** One device's answer, exactly as pushed. */
export interface DeviceItemState extends PhoneItemState {
  device: DeviceId;
  /** Whether this server has the device on at all. `gated` and `held` are `false` when not. */
  enabled: boolean;
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
 * `mica_battery_item`, the item that recharges a phone (MICA-257; `services/Battery.ts` has the
 * rest and re-exports these). Read here since MICA-263 so the tablet item can be refused when
 * it names the same thing — see where the tablet registers, below. Defaults on, unlike the
 * device items: an item nobody has is simply an item nobody uses.
 */
export const BATTERY_ITEM_CONVAR = 'mica_battery_item';
const DEFAULT_BATTERY_ITEM = 'battery_bank';

let reportedBadBatteryName = false;

/** Test seam, like `__resetPhoneItemWarnings`. */
export const __resetBatteryItemWarnings = (): void => {
  reportedBadBatteryName = false;
};

/** The item that recharges a phone, or `null` when this server has turned it off. */
export const batteryItemName = (): string | null => {
  const raw = String(GetConvar(BATTERY_ITEM_CONVAR, DEFAULT_BATTERY_ITEM)).trim();
  if (!raw) return null;
  if (!ITEM_NAME.test(raw)) {
    if (!reportedBadBatteryName) {
      reportedBadBatteryName = true;
      console.warn(
        `[mica] ${BATTERY_ITEM_CONVAR} is set to '${raw}', which is not an item name any ` +
          `inventory here would accept (letters, digits, '_' and '-', up to 64). No item ` +
          `recharges the phone. Reported once per resource start.`
      );
    }
    return null;
  }
  return raw;
};

/** Whether this server has the device on. The phone always; the tablet only by `mica_tablet`. */
export const isDeviceEnabled = (device: DeviceId): boolean => {
  const read = readEnableConvar[device];
  if (!read) return true;
  return ON.has(read().trim().toLowerCase());
};

/** Every device this server has on, the phone first and always. */
export const enabledDevices = (): DeviceId[] => ALL_DEVICES.filter(isDeviceEnabled);

/**
 * The item a device's gate is on, or `null` when there is no gate: the convar is empty, names
 * something no inventory would accept, or this server runs standalone. Says nothing about
 * whether the device is enabled; `deviceState` asks that first.
 */
export const deviceItemName = (device: DeviceId): string | null => {
  const convar = DEVICE_CONVARS[device].item;
  const raw = readItemConvar[device]().trim();
  if (!raw) return null;
  if (!ITEM_NAME.test(raw)) {
    reportOnce(
      `name:${device}`,
      `[mica] ${convar} is set to '${raw}', which is not an item name any inventory here ` +
        `would accept (letters, digits, '_' and '-', up to 64). The ${device} is not gated ` +
        `on it. Reported once per resource start.`
    );
    return null;
  }
  if (detectFramework() === 'standalone') {
    reportOnce(
      `standalone:${device}`,
      `[mica] ${convar} is set to '${raw}', but this server runs standalone and has no ` +
        `inventory to hold it in, so the ${device} is not gated on it. Reported once per ` +
        `resource start.`
    );
    return null;
  }
  return raw;
};

/** The phone's item, as it always was. Read by `services/Phones.ts`'s resolver. */
export const phoneItemName = (): string | null => deviceItemName('phone');

const heldBy = (player: FrameworkPlayer, item: string, device: DeviceId): boolean => {
  const count = FrameworkBridge.countItem(player, item);
  if (count === null) {
    reportOnce(
      `count:${device}`,
      `[mica] ${DEVICE_CONVARS[device].item} is '${item}', but no inventory here can say how ` +
        `many a player holds (ox_inventory's GetItemCount, a qb player's GetItemByName, or an ` +
        `ESX xPlayer's getInventoryItem). The ${device} is left open rather than locked for ` +
        `everyone. Reported once per resource start.`
    );
    return true;
  }
  return count > 0;
};

/**
 * Whether this player holds a phone item, counted now, with nothing pushed and nobody
 * notified — the read-only half of `evaluateDeviceItems`, for the `HasPhoneItem` export.
 * `true` whenever there is no gate (convar empty or invalid, or standalone), and `true` when
 * no inventory can count, for the fail-open reason in this file's preamble.
 */
export const holdsPhoneItem = (player: FrameworkPlayer): boolean => {
  const item = phoneItemName();
  return item ? heldBy(player, item, 'phone') : true;
};

/** One device's answer for one player, counted now. Nothing pushed. */
const deviceState = (player: FrameworkPlayer, device: DeviceId): DeviceItemState => {
  // An off device is not counted: nothing can open it, so there is nothing to relay either.
  if (!isDeviceEnabled(device)) return { device, enabled: false, gated: false, held: false };
  const item = deviceItemName(device);
  return item
    ? { device, enabled: true, gated: true, held: heldBy(player, item, device) }
    : { device, enabled: true, gated: false, held: true };
};

const pushDeviceState = (src: number, state: DeviceItemState): void => {
  emitNet(PUSH_EVENT, src, state);
  if (DEVICE_CONVARS[state.device].enable !== null) {
    emitNet(SERVER_ENABLED_EVENT, src, { device: state.device, enabled: state.enabled });
  }
};

/**
 * Whoever needs to know that a player's phone situation may have changed (MICA-284).
 *
 * Three things can change which phone a player is on, and this file is where all three are
 * observed: the load, the usable-item callback (which is how a player *switches* phones), and
 * the client's relay of an inventory change (which is how a player loses one). A subscriber
 * here is told about all three, once each, and is handed a source that has already been
 * established — the load through `onPlayerLoaded`, the other two from a framework callback
 * or a guarded net event on the connection itself — so it has no identity to resolve and
 * therefore none to get wrong (MICA-136).
 *
 * Its first subscriber is the number sync in `services/PhoneNumbers.ts`, which cannot import
 * this module's callers without a cycle and cannot subscribe to `onPlayerLoaded` alone without
 * going stale the moment a player picks up a second phone.
 *
 * The same contract as `dispatchPlayerLoaded`: one subscriber failing must not take the others
 * with it, and must not fail the event that fired it.
 */
type PhoneStateRun = (src: number) => unknown;

const phoneStateSubscribers: { name: string; run: PhoneStateRun }[] = [];

export const onPhoneStateChanged = (name: string, run: PhoneStateRun): void => {
  phoneStateSubscribers.push({ name, run });
};

/** Test seam: what has subscribed, so a suite can drive one subscriber by name. */
export const __phoneStateSubscribers = (): readonly { name: string; run: PhoneStateRun }[] =>
  phoneStateSubscribers;

const notifyPhoneState = (src: number): void => {
  for (const subscriber of phoneStateSubscribers) {
    try {
      const pending = subscriber.run(src);
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        void (pending as Promise<unknown>).catch((error: unknown) => {
          console.error(
            `[mica] phone-state subscriber '${subscriber.name}' rejected for source ${src}. ` +
              `The other subscribers still ran.`,
            error
          );
        });
      }
    } catch (error) {
      console.error(
        `[mica] phone-state subscriber '${subscriber.name}' threw for source ${src}. ` +
          `The other subscribers still ran.`,
        error
      );
    }
  }
};

/**
 * Count every device now and tell the client, one push per device. `null`, and nothing
 * pushed, for a source with no loaded character; `onPlayerLoaded` brings them here once there
 * is one.
 *
 * Pushed even when there is no gate, so the client learns it need not relay inventory changes
 * at all, and pushed for an off device, so the client keeps it shut. Then the phone-state
 * subscribers are told, gate or no gate, once — they are the phone's (MICA-284), and a pass
 * that also counted a tablet changes nothing about which phone a player is on.
 */
export const evaluateDeviceItems = (src: number): DeviceItemState[] | null => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player) return null;
  const states = ALL_DEVICES.map((device) => deviceState(player, device));
  for (const state of states) pushDeviceState(src, state);
  notifyPhoneState(src);
  return states;
};

/**
 * Which slot each source last used a phone from (MICA-280).
 *
 * The active phone is "the one you last used", and this is where that is recorded — here
 * rather than beside the resolver in `services/Phones.ts`, because that file imports this one
 * and the reverse would close a runtime cycle. The rule that *reads* this still lives in one
 * place; only the fact being recorded lives here, next to the callback that observes it.
 *
 * **Cleared on `playerDropped`, and that is not optional.** FiveM hands server ids straight
 * back out, so an entry left behind points whoever lands on that id next at a slot in an
 * inventory that is not theirs — `Battery.ts`'s `forgetSource` is the same hazard, written up
 * at length. Keyed by source rather than citizenid because "which phone am I holding" is a
 * property of the session, not of the character.
 */
const lastUsed = new Map<number, number>();

/** The slot this source last used a phone from, if they have used one this session. */
export const lastUsedPhoneSlot = (src: number): number | undefined => lastUsed.get(src);

/** Test seam, like `__resetPhoneItemWarnings`. */
export const __resetLastUsedPhone = (): void => {
  lastUsed.clear();
};

on('playerDropped', () => {
  lastUsed.delete(source);
});

/**
 * What the framework hands the callback beside the source.
 *
 * qbx_core annotates `CreateUseableItem`'s callback as `fun(source, item)` and ox_inventory
 * fills that second argument with the slot data. It is typed loosely because it is another
 * resource's shape: a framework that passes nothing simply means no slot was observed, and
 * the resolver falls back to the lowest slot rather than failing.
 */
export interface UsedItem {
  slot?: unknown;
}

/**
 * Using the item opens the phone. The framework calls this only for an item in that player's
 * own inventory, so holding it is established and the count is not asked again.
 *
 * The slot is recorded because using a phone is what makes it the active one. A player with a
 * burner and their own phone switches between them by using the one they want, which is a
 * visible act — where switching by dragging items between slots would not be.
 */
const phoneItemUsed = (source: number, used?: UsedItem): void => {
  const slot = used?.slot;
  const previous = lastUsed.get(source);
  if (typeof slot === 'number' && Number.isInteger(slot) && slot > 0) lastUsed.set(source, slot);

  pushDeviceState(source, { device: 'phone', enabled: true, gated: true, held: true });
  emitNet(OPEN_EVENT, source);
  notifyPhoneState(source);

  /**
   * Switching phones switches the whole phone (MICA-283). The shell's stores were loaded
   * for the phone that was active before, so a different slot means everything the phone
   * shows — contacts, threads, settings, the lock screen's own passcode status — is somebody
   * else's until re-read. The same push a character load sends, for the same reason.
   */
  if (previous !== undefined && lastUsed.get(source) !== previous) pushRehydrate(source);
};

/**
 * Using a tablet opens it, and that is all it does. No slot is recorded, no phone-state
 * subscriber is told and nothing is rehydrated: each of those is about which *phone* a player
 * is on, and the tablet has no identity for any of them to follow until MICA-264.
 */
const tabletItemUsed = (source: number): void => {
  pushDeviceState(source, { device: 'tablet', enabled: true, gated: true, held: true });
  emitNet(OPEN_EVENT, source, { device: 'tablet' });
};

const configuredPhone = phoneItemName();
if (configuredPhone) {
  FrameworkBridge.registerUsableItem(configuredPhone, phoneItemUsed);
}

/**
 * Only while `mica_tablet` is on: an off tablet has no item to use.
 *
 * **One item cannot be two things.** A framework keeps one usable-item callback per name, so a
 * second registration silently replaces the first — a tablet item equal to the phone's would
 * stop the phone opening on use, and one equal to `mica_battery_item` would stop the battery
 * bank charging (it registers after this file, so it would win and the tablet would never
 * open instead). Either way the tablet is the one refused, said once at start: the phone and
 * the battery bank predate it. Holding the phone item still satisfies the tablet's gate, since
 * the count is by name; the battery item does too, which is the owner's to fix.
 */
const tabletItemConflict = (item: string): string | null => {
  if (item === configuredPhone) return PHONE_ITEM_CONVAR;
  if (item === batteryItemName()) return BATTERY_ITEM_CONVAR;
  return null;
};

const configuredTablet = isDeviceEnabled('tablet') ? deviceItemName('tablet') : null;
const tabletConflict = configuredTablet ? tabletItemConflict(configuredTablet) : null;
if (configuredTablet && tabletConflict) {
  reportOnce(
    'shared-item',
    `[mica] ${TABLET_ITEM_CONVAR} and ${tabletConflict} are both '${configuredTablet}', and a ` +
      `framework keeps one use callback per item. The tablet's is not registered, so using ` +
      `it does what ${tabletConflict} says; the tablet still needs one held, but opens only ` +
      `by its keybind. Give the tablet its own item to make it usable.`
  );
} else if (configuredTablet) {
  FrameworkBridge.registerUsableItem(configuredTablet, tabletItemUsed);
}

/**
 * "Look again": the client relays an inventory change, or a refused open, and the server
 * counts every device. Guarded like every other raw net event (`docs/security.md`, category
 * 2), and the request carries nothing, so there is nothing in it to believe — not even which
 * device, which is why every device is counted.
 */
onNet('mica:server:shell:checkDeviceItem', (...args: unknown[]) => {
  const src = source;
  if (!guardNetEvent('shell', 'checkDeviceItem', noInput, args)) return;
  evaluateDeviceItems(src);
});

onPlayerLoaded('phone-item', (src) => {
  evaluateDeviceItems(src);
});
