// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ALL_DEVICES, type DeviceId } from '@mica/shared/devices';
import { detectFramework, FrameworkBridge } from './FrameworkBridge';
import type { ItemSlot } from './framework/itemMetadata';
import type { FrameworkPlayer } from './framework/runtime';
import { guardNetEvent, noInput } from './netGuard';
import { forgetOnPlayerLoaded, onPlayerLoaded, pushRehydrate } from './shell';
import { traceOf } from './sqlErrors';

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
 * **The tablet is on unless `mica_tablet` turns it off.** It was off by default while it had
 * no identity of its own (MICA-252, decision 5); since MICA-264 it has one — its own row in
 * `mica_devices`, its own notes, settings and lock screen — so it ships on like the phone. Off
 * means no usable item is registered for it, `shell:capabilities` leaves it out of `devices`,
 * every push tells the client it is off, and `ServiceEndpoint` refuses every request that
 * names it. The phone has no enable convar and is always on.
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
 * **What MICA-219 built on the item is per device since MICA-264.** Each device records its
 * own last-used slot (`lastUsedDeviceSlot`) and rehydrates the shell when a use switches to a
 * different one, because a tablet has an identity to follow now as a phone does. The
 * phone-state subscribers stay the phone's alone: their one subscriber is the number sync, and
 * a tablet has no number.
 *
 * **Holding one means holding one of your own** (MICA-436). A phone belongs to the citizen who
 * first used it, for good, so where the inventory lists slots a slot counts only when it is the
 * player's own device, theirs to claim, or blank — the rule `services/Devices.ts` resolves by
 * (`SlotJudge`). A player holding nothing but other people's phones is told they hold none, and
 * the shell stays shut for them instead of opening onto a phone that refuses every tap.
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
  tablet: () => String(GetConvar(TABLET_ENABLE_CONVAR, 'true'))
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

/** Whether this server has the device on. The phone always; the tablet unless `mica_tablet` is off. */
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

/** The phone's item, as it always was. */
export const phoneItemName = (): string | null => deviceItemName('phone');

/**
 * Whether a citizen may use the device in a slot (MICA-436): the rule `services/Devices.ts`
 * resolves a slot by, installed from there because that file imports this one. Sharing it is
 * what keeps the gate and the resolve from disagreeing — a gate that counted any slot would
 * open the shell for a player every device-owned request then refuses.
 */
export interface SlotJudge {
  /** From what this process already knows; `null` for a slot whose row it has not read. */
  known: (citizenid: string, device: DeviceId, slot: ItemSlot) => boolean | null;
  /** The same answer, reading the slot's row when it must. Never writes. */
  read: (citizenid: string, device: DeviceId, slot: ItemSlot) => Promise<boolean>;
}

let slotJudge: SlotJudge | null = null;

/** Called once, by `services/Devices.ts`, at import. A test may pass `null` to clear it. */
export const installSlotJudge = (judge: SlotJudge | null): void => {
  slotJudge = judge;
};

/**
 * Held by count — any copy at all. What an inventory that cannot list slots (es_extended's own)
 * is asked, so the gate fails open exactly where it always has; and what a process with no
 * judge installed asks, which is only a suite that never loads `services/Devices.ts`.
 */
const counted = (player: FrameworkPlayer, item: string, device: DeviceId): boolean => {
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
 * Whether this player holds a device of their own, from what this process knows (MICA-436).
 * A slot whose row has not been read yet counts as held: synchronous callers cannot wait for
 * it, and "cannot say" is never "holds none" here. `heldByRead` is what the gate pushes.
 */
const heldBy = (player: FrameworkPlayer, item: string, device: DeviceId): boolean => {
  const judge = slotJudge;
  const slots = judge ? FrameworkBridge.itemSlots(player, item) : null;
  if (!judge || !slots) return counted(player, item, device);
  return slots.some((slot) => judge.known(player.citizenid, device, slot) !== false);
};

/**
 * `heldBy`, reading every row it has to first, so the push says what is true for a slot this
 * process has not seen — a phone just taken, after a restart. A read that fails counts the slot
 * as held, said each time: the gate fails open where nothing can say, as a count does.
 */
const heldByRead = async (
  player: FrameworkPlayer,
  item: string,
  device: DeviceId
): Promise<boolean> => {
  const judge = slotJudge;
  const slots = judge ? FrameworkBridge.itemSlots(player, item) : null;
  if (!judge || !slots) return counted(player, item, device);
  const known = slots.map((slot) => judge.known(player.citizenid, device, slot));
  if (known.includes(true)) return true;
  for (const [index, slot] of slots.entries()) {
    if (known[index] !== null) continue;
    try {
      if (await judge.read(player.citizenid, device, slot)) return true;
    } catch (error) {
      console.error(
        `[mica] could not read whose ${device} source ${player.source} is holding; it is left ` +
          'open, and every request it makes is still held to the resolve.',
        traceOf(error)
      );
      return true;
    }
  }
  return false;
};

/**
 * Whether this player holds an item of this device of their own, answered now, with nothing
 * pushed and nobody notified — the read-only half of `evaluateDeviceItems`, for the
 * `HasPhoneItem` export and `ServiceEndpoint`'s check on a request that names a device
 * (MICA-264). `true` whenever there is no gate (convar empty or invalid, or standalone), and
 * `true` when no inventory can count, for the fail-open reason in this file's preamble.
 * Synchronous, so it rules on what this process knows (`heldBy`, MICA-436). Says nothing about
 * whether the device is enabled; ask `isDeviceEnabled` for that.
 */
export const holdsDevice = (player: FrameworkPlayer, device: DeviceId): boolean => {
  const item = deviceItemName(device);
  return item ? heldBy(player, item, device) : true;
};

/**
 * `holdsDevice`, reading every slot's row this process has not seen first (MICA-436 review):
 * what a request that moves money or publishes is held to (`ServiceEndpoint`'s
 * `requirePhoneFor`), so a player holding nothing but somebody else's phone is refused on the
 * first request rather than once something else happens to read the row. One read per unseen
 * id, then cached.
 */
export const holdsDeviceRead = async (
  player: FrameworkPlayer,
  device: DeviceId
): Promise<boolean> => {
  const item = deviceItemName(device);
  return item ? await heldByRead(player, item, device) : true;
};

/** `holdsDevice` for the phone. */
export const holdsPhoneItem = (player: FrameworkPlayer): boolean => holdsDevice(player, 'phone');

/** One device's answer for one player, every row it rules on read. Nothing pushed. */
const deviceState = async (player: FrameworkPlayer, device: DeviceId): Promise<DeviceItemState> => {
  // An off device is not counted: nothing can open it, so there is nothing to relay either.
  if (!isDeviceEnabled(device)) return { device, enabled: false, gated: false, held: false };
  const item = deviceItemName(device);
  return item
    ? { device, enabled: true, gated: true, held: await heldByRead(player, item, device) }
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

/** Run one subscriber as its own failure: a throw or a rejection is logged, never raised. */
const runSubscriber = (what: string, name: string, src: number, run: () => unknown): void => {
  try {
    const pending = run();
    if (pending && typeof (pending as Promise<unknown>).then === 'function') {
      void (pending as Promise<unknown>).catch((error: unknown) => {
        console.error(
          `[mica] ${what} subscriber '${name}' rejected for source ${src}. ` +
            `The other subscribers still ran.`,
          traceOf(error)
        );
      });
    }
  } catch (error) {
    console.error(
      `[mica] ${what} subscriber '${name}' threw for source ${src}. ` +
        `The other subscribers still ran.`,
      traceOf(error)
    );
  }
};

const notifyPhoneState = (src: number): void => {
  for (const subscriber of phoneStateSubscribers) {
    runSubscriber('phone-state', subscriber.name, src, () => subscriber.run(src));
  }
};

/**
 * Whoever needs to know that a player's device of some kind may have changed (MICA-264): the
 * phone-state hook's twin for every device that is not the phone, told on the same occasions —
 * a load, the client's relay of an inventory change — and on using that device's item.
 *
 * Separate from `onPhoneStateChanged` because that hook's subscribers are the number sync and
 * the battery, both the phone's alone, and a tablet use must not wake them. Its subscriber is
 * `services/Devices.ts`, which re-resolves the tablet so the synchronous answer `LockState` keys
 * on follows a switch, a robbery or a character switch rather than waiting for the next
 * device-owned request. The phone needs no entry here: its own subscribers resolve it already.
 */
type DeviceStateRun = (src: number, device: DeviceId) => unknown;

const deviceStateSubscribers: { name: string; run: DeviceStateRun }[] = [];

export const onDeviceStateChanged = (name: string, run: DeviceStateRun): void => {
  deviceStateSubscribers.push({ name, run });
};

const notifyDeviceState = (src: number, devices: readonly DeviceId[]): void => {
  for (const device of devices) {
    if (device === 'phone') continue;
    for (const subscriber of deviceStateSubscribers) {
      runSubscriber('device-state', subscriber.name, src, () => subscriber.run(src, device));
    }
  }
};

/**
 * The newest pass each source has started (MICA-436 review). A pass that waits on a row read can
 * land after a pass started later — a phone dropped and the relay's pass answered from the cache
 * — and its older `held: true` would undo the newer `held: false`. So every pass takes a number,
 * and one that is no longer the newest for its source when its reads land pushes nothing and
 * tells nobody. Numbered from one counter for every source, and forgotten on `playerDropped`, so
 * a pass left over from the player who had this id before never matches the next one's.
 */
let passes = 0;
const latestPass = new Map<number, number>();

const startPass = (src: number): number => {
  passes += 1;
  latestPass.set(src, passes);
  return passes;
};

const isLatestPass = (src: number, pass: number): boolean => latestPass.get(src) === pass;

/**
 * Count every device now and tell the client, one push per device. `null`, and nothing
 * pushed, for a source with no loaded character; `onPlayerLoaded` brings them here once there
 * is one.
 *
 * Pushed even when there is no gate, so the client learns it need not relay inventory changes
 * at all, and pushed for an off device, so the client keeps it shut. Then the phone-state
 * subscribers are told, gate or no gate, once — they are the phone's (MICA-284), and a pass
 * that also counted a tablet changes nothing about which phone a player is on.
 *
 * **Asynchronous since MICA-436**: whose phone a slot carries is a row, and a phone just taken
 * from somebody is one this process may not have read. A pass whose source has another
 * character by the time the reads land pushes nothing and answers `null` — a character switch
 * keeps the source (MICA-336), and that character's own load runs a pass of its own.
 */
export const evaluateDeviceItems = async (src: number): Promise<DeviceItemState[] | null> => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player) return null;
  const pass = startPass(src);
  const states = await Promise.all(ALL_DEVICES.map((device) => deviceState(player, device)));
  if (!isLatestPass(src, pass)) return null;
  if (FrameworkBridge.getPlayer(src)?.citizenid !== player.citizenid) return null;
  for (const state of states) pushDeviceState(src, state);
  notifyPhoneState(src);
  // Every other device, on or off: an off one is re-resolved to nothing, which clears it.
  notifyDeviceState(src, ALL_DEVICES);
  return states;
};

/**
 * Which slot each source last used each device from (MICA-280; per device since MICA-264).
 *
 * The active phone is "the one you last used", and this is where that is recorded — here
 * rather than beside the resolver in `services/Devices.ts`, because that file imports this one
 * and the reverse would close a runtime cycle. The rule that *reads* this still lives in one
 * place; only the fact being recorded lives here, next to the callback that observes it.
 *
 * **Cleared on `playerDropped`, and that is not optional.** FiveM hands server ids straight
 * back out, so an entry left behind points whoever lands on that id next at a slot in an
 * inventory that is not theirs — `Battery.ts`'s `forgetSource` is the same hazard, written up
 * at length. Keyed by source rather than citizenid because "which phone am I holding" is a
 * property of the session — and a character switch starts a new one, so a switch
 * clears it as well (MICA-336).
 */
const lastUsed = Object.fromEntries(
  ALL_DEVICES.map((device) => [device, new Map<number, number>()])
) as Record<DeviceId, Map<number, number>>;

/** The slot this source last used this device from, if they have used one this session. */
export const lastUsedDeviceSlot = (src: number, device: DeviceId): number | undefined =>
  lastUsed[device].get(src);

/** Test seam, like `__resetPhoneItemWarnings`. Every device's slots. */
export const __resetLastUsedPhone = (): void => {
  for (const device of ALL_DEVICES) lastUsed[device].clear();
};

const forgetLastUsed = (src: number): void => {
  for (const device of ALL_DEVICES) lastUsed[device].delete(src);
};

on('playerDropped', () => {
  forgetLastUsed(source);
  latestPass.delete(source);
});

/**
 * And on a character switch (MICA-336), which keeps the source and fires no drop. The
 * slot was the previous character's: in the next character's inventory it names whatever
 * they keep there, so the resolver would prefer it over the lowest slot for no reason they
 * gave. Forgotten before any subscriber resolves a device, so the load's own resolve already
 * reads it empty and falls back to the lowest slot, as a first use this session does.
 */
forgetOnPlayerLoaded('device-last-used', forgetLastUsed);

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
 * Record the slot a device was used from, and answer whether that switched the player to a
 * different one of it. A first use this session is not a switch: there is nothing loaded for
 * another one yet.
 */
const recordUse = (source: number, device: DeviceId, used?: UsedItem): boolean => {
  const slots = lastUsed[device];
  const slot = used?.slot;
  const previous = slots.get(source);
  if (typeof slot === 'number' && Number.isInteger(slot) && slot > 0) slots.set(source, slot);
  return previous !== undefined && slots.get(source) !== previous;
};

/** A pass nobody waits on: a rejection is logged, never left unhandled. */
const evaluateInBackground = (src: number): void => {
  void evaluateDeviceItems(src).catch((error: unknown) => {
    console.error(`[mica] could not count the devices source ${src} holds.`, traceOf(error));
  });
};

/**
 * Whether the slot a use came from holds a device this player may use (MICA-436), by the judge
 * the gate counts by. A boolean when that is known now, and a promise only when the slot's row
 * has to be read first, so an ordinary use opens in the same tick it always did. `true` when it
 * cannot tell which slot, or whose — no judge, no slot in the framework's answer, a read that
 * failed — and the resolve decides then, as it always did.
 */
const usedOwnDevice = (
  source: number,
  device: DeviceId,
  used?: UsedItem
): boolean | Promise<boolean> => {
  const judge = slotJudge;
  const item = deviceItemName(device);
  const player = judge && item ? FrameworkBridge.getPlayer(source) : null;
  if (!judge || !item || !player) return true;
  const slot = FrameworkBridge.itemSlots(player, item)?.find((entry) => entry.slot === used?.slot);
  if (!slot) return true;
  const known = judge.known(player.citizenid, device, slot);
  if (known !== null) return known;
  const read = judge.read(player.citizenid, device, slot).catch((error: unknown) => {
    console.error(
      `[mica] could not read whose ${device} source ${source} used; it opens, and every ` +
        'request it makes is still held to the resolve.',
      traceOf(error)
    );
    return true;
  });
  // The read yielded (MICA-436 review): open only if the source is still this character and
  // the slot still carries the id that was read. A switch or a swap meanwhile opens nothing.
  return read.then((own) => own && stillHolds(source, player.citizenid, item, slot));
};

/** Whether this source is still this character, with this slot still carrying this id. */
const stillHolds = (source: number, citizenid: string, item: string, slot: ItemSlot): boolean => {
  const now = FrameworkBridge.getPlayer(source);
  if (now?.citizenid !== citizenid) return false;
  const again = FrameworkBridge.itemSlots(now, item)?.find((entry) => entry.slot === slot.slot);
  return again?.metadata.deviceId === slot.metadata.deviceId;
};

/**
 * Open what was used when it is the player's own, else open nothing (MICA-436): somebody
 * else's phone used from the inventory records no slot, and a pass tells the client what the
 * player does hold — their own phone beside it still opens by its keybind.
 */
const useIfOwn = (
  source: number,
  device: DeviceId,
  used: UsedItem | undefined,
  open: () => void
): void => {
  const own = usedOwnDevice(source, device, used);
  if (own === true) return open();
  if (own === false) return evaluateInBackground(source);
  void own
    .then((yes) => (yes ? open() : evaluateInBackground(source)))
    .catch((error: unknown) => {
      console.error(`[mica] could not open the ${device} source ${source} used.`, traceOf(error));
    });
};

/**
 * Using the item opens the phone. The framework calls this only for an item in that player's
 * own inventory, so holding it is established and the count is not asked again — but whose
 * phone it is is asked (`useIfOwn`, MICA-436).
 *
 * The slot is recorded because using a phone is what makes it the active one. A player with a
 * burner and their own phone switches between them by using the one they want, which is a
 * visible act — where switching by dragging items between slots would not be.
 */
const phoneItemUsed = (source: number, used?: UsedItem): void =>
  useIfOwn(source, 'phone', used, () => openPhone(source, used));

const openPhone = (source: number, used?: UsedItem): void => {
  const switched = recordUse(source, 'phone', used);

  pushDeviceState(source, { device: 'phone', enabled: true, gated: true, held: true });
  emitNet(OPEN_EVENT, source);
  notifyPhoneState(source);

  /**
   * Switching phones switches the whole phone (MICA-283). The shell's stores were loaded
   * for the phone that was active before, so a different slot means everything the phone
   * shows — contacts, threads, settings, the lock screen's own passcode status — is somebody
   * else's until re-read. The same push a character load sends, for the same reason.
   */
  if (switched) pushRehydrate(source);
};

/**
 * Using a tablet opens it, and records its slot as the phone's use does (MICA-264): the tablet
 * has an identity now, so a player with two of them switches by using the other, and the
 * shell's stores — its notes, settings, lock screen — have to be re-read when they do. No
 * phone-state subscriber is told: they follow the phone's number and battery, which a tablet
 * does not have. The device-state subscribers are, so the tablet's id follows the use. Somebody
 * else's tablet opens nothing, as a phone does not (`useIfOwn`, MICA-436).
 */
const tabletItemUsed = (source: number, used?: UsedItem): void =>
  useIfOwn(source, 'tablet', used, () => openTablet(source, used));

const openTablet = (source: number, used?: UsedItem): void => {
  const switched = recordUse(source, 'tablet', used);
  pushDeviceState(source, { device: 'tablet', enabled: true, gated: true, held: true });
  emitNet(OPEN_EVENT, source, { device: 'tablet' });
  notifyDeviceState(source, ['tablet']);
  if (switched) pushRehydrate(source);
};

const configuredPhone = phoneItemName();
if (configuredPhone) {
  // log-identity-ok: the phone item's configured name, not a phone or a player
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
  evaluateInBackground(src);
});

onPlayerLoaded('phone-item', async (src) => {
  await evaluateDeviceItems(src);
});
