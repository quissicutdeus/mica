// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The server half of the battery service.
import {
  ALL_DEVICES,
  DEFAULT_DEVICE,
  DEVICES,
  isDeviceId,
  type DeviceId
} from '@mica/shared/devices';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { defineService } from '../lib/defineService';
import { PhoneBattery } from '@mica/shared/types';
import { isAdmin } from './Admin';
import { onPlayerLoaded, notifyPlayer } from '../lib/shell';
import { batteryLevel, guardNetEvent, noInput } from '../lib/netGuard';
import { s } from '@mica/shared/schema';
import {
  __resetBatteryItemWarnings,
  batteryItemName,
  enabledDevices,
  isDeviceEnabled,
  onDeviceStateChanged,
  onPhoneStateChanged
} from '../lib/deviceItem';
import { isDeviceOpen } from '../lib/PhoneOpenState';
import { phoneForCitizen, phoneForRequest } from '../lib/phoneIdentity';
import { activeDeviceIdOf } from './Phones';
import { PlayerFacingError } from '../lib/errors';

/**
 * micaOS owns the saved charge, in its own table.
 *
 * It used to live only in framework character metadata, which is why it kept coming
 * back as 100%: metadata is held in memory and written to the `players` row when the
 * *framework* decides to save — logout, its autosave interval, a clean shutdown. A
 * server crash, an `ensure qbx_core`, or a restart between autosaves throws the value
 * away. The in-memory `playerBatteryStore` fallback was worse still: wiped by every
 * `ensure mica`.
 *
 * No NUI surface: all four generic actions are off and the client reaches battery only
 * through the named events below. `write: 'server'` keeps the columns non-client-writable
 * on top of that.
 */
export const batteryApp = defineService<PhoneBattery>({
  id: 'battery',
  // The charge is the device's (MICA-283): two phones hold two charges, and a battery bank
  // charges the one in hand. The tablet has one of its own (MICA-337), keyed on the tablet's
  // id exactly as a phone's is on the phone's — the same column and the same unique index,
  // since the ids of the two kinds never collide.
  deviceOwned: true,
  devices: ['phone', 'tablet'],
  access: { read: 'owner', write: 'server' },
  schema: {
    level: { type: 'int', notNull: true, default: 100 }
  },
  // One row per **phone**, enforced by the database rather than by a find-then-write that
  // can interleave with the drain save. `0003_battery_follows_the_phone` swapped the old
  // `citizenid_unique` for it.
  indexes: [{ name: 'phone_id_unique', columns: ['phone_id'], unique: true }],
  // The save writes the phone's active row or creates one (`findAll` reads `active` only), so a
  // deleted row under the key would refuse every save for that phone. Nothing deletes a battery
  // today; if anything ever does, the next save revives the row with the level it carries.
  uniqueAfterDelete: 'revive',
  options: {
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  }
});

/**
 * Last level written per **phone** (MICA-283; per citizenid before it).
 *
 * The drain loop reports every 15 seconds but only moves the charge 0.25% in that time,
 * so most reports are the same whole percent as the last. Skipping those turns four
 * writes per player per minute into one.
 *
 * Bounded, because the key is a phone rather than a source: nothing removes an entry on
 * the ordinary path, so a server that has been up for a week would hold every phone that
 * ever logged in. `Map` iterates in insertion order, so evicting the first key drops the
 * phone written longest ago — and a phone that ages out simply pays one redundant write on
 * its next report, which is the cost this cache exists to avoid, not a correctness problem.
 */
const WRITE_CACHE_LIMIT = 512;
const lastWritten = new Map<string, number>();

const rememberWrite = (phoneId: string, level: number): void => {
  lastWritten.set(phoneId, level);
  while (lastWritten.size > WRITE_CACHE_LIMIT) {
    const oldest = lastWritten.keys().next().value;
    if (oldest === undefined) break;
    lastWritten.delete(oldest);
  }
};

/**
 * Which phone each connected source's live charge belongs to (MICA-283).
 *
 * The live maps below are keyed by source and the write-skip cache by phone, so a disconnect
 * can only forget the right cache entry if it knows which phone that source was on — and a
 * phone switch can only save the old phone's charge if it still knows which phone that was.
 * Recorded here rather than resolved on the way out, because by the time `playerDropped`
 * fires the framework may already have unloaded the player and there would be nothing left
 * to ask.
 */
/**
 * Every piece of live state below is held **per device** (MICA-337): one map per kind, each
 * keyed by source, so a player carrying a phone and a tablet has two charges, two owning ids,
 * two charging flags and two load marks, and nothing one device does reaches the other — a
 * dead tablet never blocks the phone, and the reverse. The same shape `services/Phones.ts`
 * keeps its `activeBySource` in.
 */
type PerDevice<V> = Record<DeviceId, Map<number, V>>;

const perDevice = <V>(): PerDevice<V> =>
  Object.fromEntries(ALL_DEVICES.map((device) => [device, new Map<number, V>()])) as PerDevice<V>;

const phoneOf = perDevice<string>();

/**
 * Sources whose last load of a device found none in hand (MICA-337). A later device-state
 * event — the item picked up — loads that device's charge then, where a switch with no
 * previous device would otherwise stay silent and leave a tablet acquired after the character
 * loaded with no charge until the next reconnect. The phone gets the same, for the same case.
 */
const heldNone = perDevice<true>();

/**
 * Sources whose character has loaded, or that asked for their charge (MICA-337): the ones the
 * tick looks at for a tablet that has come into use since. Cleared with everything else.
 */
const knownSources = new Set<number>();

/**
 * A device id the previous character on this source was using, recorded at a character switch
 * (MICA-337). `activeDeviceIdOf` still answers it until `services/Phones.ts` re-resolves for the
 * new character, which happens asynchronously on the same load — and loading it in that gap
 * would show, tick and save the previous character's tablet. Refused while the cache still
 * answers it; the mark goes as soon as the answer changes.
 */
const staleIdentity = perDevice<string>();

/**
 * Sources whose last load could not read the table (MICA-326), with the ticks left until the
 * loop tries again. Their live charge is either unset or the last one known for the same
 * phone — never a guess.
 *
 * A failed read used to read as "no saved row": the charge defaulted to the legacy metadata or
 * 100 and the adoption save wrote it, so one transient error overwrote a saved 12% with a full
 * battery. Nothing is written now. The tick retries the load about once a minute
 * (`LOAD_RETRY_TICKS`) until it reads, the player leaves, or a set supersedes it; a phone-state
 * event — an inventory change on a gated server, a use of the phone, a refused open — retries
 * sooner, as do `battery:load` and a character load. The tick is the one a server without the
 * item gate relies on, because nothing there fires a phone-state event after the load.
 *
 * A retry **claims** the entry by deleting it, so at most one is in flight per source; one that
 * fails again puts it back with a fresh countdown. An explicit set (`applyCharge`) supersedes
 * the failed load and clears the entry, and `loadToken` makes a read already in flight discard
 * what it read rather than paint the stale row over the set.
 */
const loadFailed = perDevice<number>();

/**
 * The load each source is waiting on (MICA-326), as an identity token.
 *
 * A load reads the table, and a set can land while that read is in flight — a battery bank, an
 * export's `SetBatteryLevel`, `micacharge`. Without this the read finished afterwards and put
 * the stale row back over the set. Every load takes a fresh token before its first await and
 * checks it is still the current one after each; `applyCharge` and a disconnect delete it, and
 * a newer load replaces it, so whichever happens last wins. Identity rather than a counter so a
 * deleted entry can never compare equal to one a load is holding.
 */
const loadToken = perDevice<object>();

/** Test seam: the write-skip cache is module state that would leak between cases. */
export const __resetBatteryCache = () => lastWritten.clear();

/**
 * Charge per connected source, ticked by the server.
 *
 * This lived on the client: it ran the drain timer and reported over
 * `mica:server:battery:save` every 15 seconds, so a modified client asserted whatever
 * charge it liked. The fix is not a better check on that event — it is that the event is
 * gone and the number is ours.
 *
 * The authoritative version is **smaller** than what it replaced: one interval and a map,
 * against a client timer plus a report path plus a clamp plus a write-skip cache that
 * existed to absorb four redundant writes a minute.
 *
 * Keyed by source rather than citizenid because it only ticks while connected — which the
 * server knows, where the client merely stopped running.
 */
const charge = perDevice<number>();
const charging = perDevice<true>();

/** Percent per minute. Draining is slow; a charger should visibly beat it. */
const DRAIN_PER_MINUTE = 1;
const CHARGE_PER_MINUTE = 10;
const TICK_MS = 5000;
/** About once a minute: a failed load retried every tick would hammer a database already in trouble. */
const LOAD_RETRY_TICKS = Math.round(60_000 / TICK_MS);

/**
 * Tell the client a device's charge. The phone's push is the bare level it has always been, so
 * a client built before MICA-337 is unchanged; any other device appends its id, which the
 * client reads as absent-means-phone.
 */
const pushCharge = (src: number, device: DeviceId, level: number): void => {
  if (typeof emitNet !== 'function') return;
  if (device === DEFAULT_DEVICE) emitNet('mica:client:battery:set', src, level);
  else emitNet('mica:client:battery:set', src, level, device);
};

/**
 * One tick for every connected player.
 *
 * Whole percents are what the phone shows, so a push and a write happen only when the
 * rounded value moves — once a minute while draining, not every five seconds. That is the
 * saving the client's `saveCounter` was reaching for, expressed where the number lives.
 */
const tickBattery = (): void => {
  // Each device on its own (MICA-337), on the same rule: a device drains while its charge is
  // held, which is while the player carries it, and charges while its own flag is set.
  for (const device of ALL_DEVICES) {
    for (const [src, level] of charge[device]) {
      const rate = charging[device].has(src) ? CHARGE_PER_MINUTE : -DRAIN_PER_MINUTE;
      const next = Math.max(0, Math.min(100, level + (rate * TICK_MS) / 60_000));
      if (next === level) continue;

      charge[device].set(src, next);
      if (Math.round(next) !== Math.round(level)) {
        pushCharge(src, device, Math.round(next));
        void savePlayerBattery(src, Math.round(next), device);
      }
    }

    // Loads that could not read the table (MICA-326). Claimed by deleting the entry, so the
    // next tick cannot start a second retry while this one is in flight.
    for (const [src, ticks] of loadFailed[device]) {
      if (ticks > 1) {
        loadFailed[device].set(src, ticks - 1);
        continue;
      }
      loadFailed[device].delete(src);
      void sendLoadedBatteryToClient(src, device).catch((error: unknown) => {
        console.error(`[mica] ${device} battery load retry for source ${src} threw`, error);
      });
    }
  }

  // A tablet that has come into use since the character loaded (MICA-337): its first request,
  // or an item resolved for it, gave it an identity, and nothing in this file was told. Loaded
  // here, at most a tick later; never before, so nobody's tablet drains unused.
  for (const src of knownSources) {
    for (const device of ALL_DEVICES) {
      if (device === DEFAULT_DEVICE || !isDeviceEnabled(device)) continue;
      if (charge[device].has(src) || loadToken[device].has(src) || loadFailed[device].has(src)) {
        continue;
      }
      if (deviceInUse(src, device) === null) continue;
      void sendLoadedBatteryToClient(src, device).catch((error: unknown) => {
        console.error(`[mica] ${device} battery load for source ${src} threw`, error);
      });
    }
  }
};

if (typeof setInterval === 'function') setInterval(tickBattery, TICK_MS);

/** Test seams: module state and a deterministic tick, rather than waiting on wall clock. */
export const __tickBattery = tickBattery;
export const __resetBatteryState = (): void => {
  for (const device of ALL_DEVICES) {
    charge[device].clear();
    charging[device].clear();
    phoneOf[device].clear();
    heldNone[device].clear();
    staleIdentity[device].clear();
    loadFailed[device].clear();
    loadToken[device].clear();
  }
  knownSources.clear();
  lastWritten.clear();
};

/**
 * Forget everything keyed to a source when its player leaves.
 *
 * FiveM hands server ids straight back out, so every one of these maps is a booby trap for
 * whoever lands on the id next: a charger left plugged in charges a stranger's phone, an
 * entry left in `charge` keeps being ticked and written for somebody who is gone, and the
 * write-skip entry makes the newcomer's first genuine save look like a duplicate and get
 * dropped.
 *
 * The charge itself is not saved here. The tick already persists on every whole-percent
 * move, so at most 1% is lost, and a save on the way out would race the framework unloading
 * the player — which is exactly when `FrameworkBridge.getPlayer` starts answering nothing.
 */
const forgetSource = (src: number): void => {
  knownSources.delete(src);
  // Every device's (MICA-337): a tablet left charging is the same booby trap as a phone.
  for (const device of ALL_DEVICES) {
    charge[device].delete(src);
    charging[device].delete(src);
    heldNone[device].delete(src);
    staleIdentity[device].delete(src);
    loadFailed[device].delete(src);
    loadToken[device].delete(src);

    const phoneId = phoneOf[device].get(src);
    if (phoneId !== undefined) lastWritten.delete(phoneId);
    phoneOf[device].delete(src);
  }
};

on('playerDropped', () => {
  forgetSource(source);
});

/** What the server believes this player's charge is — the phone's, unless `device` names another. */
export const currentCharge = (src: number, device: DeviceId = DEFAULT_DEVICE): number =>
  Math.round(charge[device].get(src) ?? 100);

/** Set the live value, tell the device, and persist. The one way charge changes outright. */
export const applyCharge = (
  src: number,
  level: number,
  device: DeviceId = DEFAULT_DEVICE
): number => {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  charge[device].set(src, clamped);
  loadFailed[device].delete(src);
  loadToken[device].delete(src);
  pushCharge(src, device, clamped);
  void savePlayerBattery(src, clamped, device);
  return clamped;
};

/**
 * The battery bank, as a server owner's option rather than a hardcoded item (MICA-257).
 *
 * `mica_battery_item` names the item that recharges a phone and `mica_battery_item_charge`
 * says how many percent it adds, so an owner picks both without editing TypeScript — the
 * same shape as `mica_phone_item` in `lib/deviceItem.ts`, and the other half of MICA-219's
 * "the phone is a thing you carry". Empty turns the item off entirely, for a server that
 * would rather recharge through a charger prop or `SetBatteryLevel`.
 *
 * The default is on. Unlike the phone item, which locks the phone for everyone when it is
 * set to an item no server defines, an item nobody has is simply an item nobody uses.
 */
/**
 * The item's name is read in `lib/deviceItem.ts` since MICA-263, beside the phone and tablet
 * items: that file refuses a tablet item equal to this one, because a framework keeps one
 * usable-item callback per name and the later registration would silently replace the
 * other. It cannot import this file for the answer — this file imports it — so the reader
 * moved rather than being copied. Re-exported so every existing import keeps working.
 */
export { batteryItemName, __resetBatteryItemWarnings };

export const BATTERY_ITEM_CHARGE_CONVAR = 'mica_battery_item_charge';

const DEFAULT_BATTERY_ITEM_CHARGE = 100;

/**
 * Percent added by one use, 1-100.
 *
 * Clamped rather than trusted: `set mica_battery_item_charge 900` is a typo, not a licence
 * to overflow the charge, and `applyCharge` would clamp the result anyway — this keeps the
 * number honest at the place an owner reads it back. The floor is 1 because an item that
 * adds nothing is an item that reads as broken.
 */
export const batteryItemCharge = (): number => {
  const raw = GetConvarInt(BATTERY_ITEM_CHARGE_CONVAR, DEFAULT_BATTERY_ITEM_CHARGE);
  if (!Number.isFinite(raw)) return DEFAULT_BATTERY_ITEM_CHARGE;
  return Math.max(1, Math.min(100, Math.round(raw)));
};

/**
 * Take one from the player's inventory, and say whether it was really there.
 *
 * **Fails closed**, which is the reverse of what this did. A source with no loaded character
 * used to answer `true` — "removed" — so anything that could reach the use path got the
 * charge without ever holding the item. `deviceItem.ts` fails *open* for the opposite reason:
 * it gates access, so an inventory it cannot read must not lock everybody out. This grants
 * something, so an inventory it cannot read must not hand it over.
 */
const removeBatteryItem = (src: number, item: string): boolean => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player) return false;
  return player.removeItem(item, 1);
};

/**
 * The id of a device other than the phone this source is already using, or `null` (MICA-337):
 * what `services/Phones.ts` last resolved it to — on a tablet request, or for a tablet item in
 * hand — and never one minted here. A cached id left over from the previous character on this
 * source is not this one's (`staleIdentity`).
 */
const deviceInUse = (src: number, device: DeviceId): string | null => {
  const id = activeDeviceIdOf(src, device);
  const stale = staleIdentity[device].get(src);
  if (stale !== undefined) {
    if (id === stale) return null;
    staleIdentity[device].delete(src);
  }
  return id;
};

/**
 * Whether this source has a device of this kind for a charge to belong to, synchronously: the
 * phone always (its path is unchanged), any other device only once its charge is loaded or it
 * has an identity in use. `SetCharging` asks it.
 */
export const hasBatteryDevice = (src: number, device: DeviceId): boolean =>
  device === DEFAULT_DEVICE || phoneOf[device].has(src) || deviceInUse(src, device) !== null;

/**
 * The phone a source's charge belongs to: the one already recorded for it, else the one in
 * its hand. `null` for a player holding no phone on a gated server — there is nothing for a
 * charge to belong to, and `phoneForRequest` says so as a `PlayerFacingError`, which is not
 * an error here but an answer.
 */
const phoneForSource = async (
  src: number,
  citizenid: string,
  device: DeviceId
): Promise<string | null> => {
  const known = phoneOf[device].get(src);
  if (known) return known;
  // Never a resolve for any other device (MICA-337): `phoneForRequest` falls back to the
  // citizen's identity device, which *mints* a tablet — a `mica_phones` row, its created hooks,
  // then a battery row and a drain — for a player who may never open one. A tablet's charge
  // follows an identity the tablet's own use created, and nothing else.
  if (device !== DEFAULT_DEVICE) return deviceInUse(src, device);
  try {
    return await phoneForRequest(src, citizenid, device);
  } catch (error) {
    if (error instanceof PlayerFacingError) return null;
    throw error;
  }
};

/**
 * Persist a charge to a device — the phone unless `device` names another. Returns silently for
 * a source with no loaded character, and for one holding none of that device.
 *
 * `phoneId` names the device explicitly when the caller knows better than the cache — the
 * switch saves the *old* device's charge after `phoneOf` has already moved on.
 */
export const savePlayerBattery = async (
  src: number,
  level: number,
  device: DeviceId = DEFAULT_DEVICE,
  phoneId?: string
): Promise<void> => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return;

  const { citizenid } = player;
  const phone = phoneId ?? (await phoneForSource(src, citizenid, device));
  if (!phone) return;
  if (!phoneId) phoneOf[device].set(src, phone);

  const safeLevel = Math.max(0, Math.min(100, Math.round(level)));
  if (lastWritten.get(phone) === safeLevel) return;
  rememberWrite(phone, safeLevel);

  // Mirrored into character metadata so other resources reading `mica_battery` keep
  // working. Our table is the authority; this is a courtesy copy — of the phone in hand, and
  // only the phone's: a resource reading `mica_battery` has only ever meant the phone.
  if (device === DEFAULT_DEVICE) player.setMeta('mica_battery', safeLevel);

  try {
    const [existing] = await batteryApp.repo.findAll({ phone_id: phone } as Partial<PhoneBattery>);
    if (existing) {
      // Scoped by the holder as well as the phone (§2.9). The holder is this citizen: the
      // resolve that produced `phone` moved the row to them if it had to.
      await batteryApp.repo.update(existing.id, { level: safeLevel }, citizenid, phone);
    } else {
      await batteryApp.repo.create({ citizenid, phone_id: phone, level: safeLevel });
    }
  } catch (e) {
    // A failed write must not take the event handler down; the next report retries.
    lastWritten.delete(phone);
    console.error('[mica] failed to save battery', e);
  }
};

/**
 * `mica:server:battery:useItem` is deliberately absent (MICA-257).
 *
 * It was a raw net event that consumed inventory, reachable by any modified client whether
 * or not anything routed to it — and nothing did: no client code, no NUI route, no export.
 * The framework's usable-item callback below is the real path, because only the framework
 * can say the item was in *that* player's inventory. A resource wanting to recharge without
 * an item has `SetBatteryLevel` and `AddBatteryCharge`, which are authenticated exports
 * rather than an event anyone can emit. MICA-210 is about exactly this category.
 *
 * Deleting an entry point beats hardening one, which is the same call `battery:save` got.
 */

/**
 * `mica:server:battery:save` is deliberately absent.
 *
 * It let the client tell the server what its charge was, which is the whole of the
 * tampering surface — no amount of validating that payload makes it something else. The
 * server owns the number now, so there is nothing for the client to report.
 */

/**
 * The Developer Tools battery slider, gated on `mica.admin`.
 *
 * Kept separate from `saveBattery` because that one is called by **every** client's
 * drain loop every 15 seconds and so cannot require admin.
 *
 * This does not make battery tamper-proof, and is not meant to. `saveBattery` is
 * client-trusted by design — the client owns the drain timer — so any player can
 * already report whatever charge they like over that event. The ace gate removes the
 * convenient UI, not the capability. Server-authoritative battery is a separate,
 * larger change: persistence (below) is not the same thing as authority.
 */
/**
 * The level, and since MICA-337 the device the slider speaks for: absent means the phone, so a
 * client built before the tablet had a battery sends exactly what it always did.
 */
const SET_BATTERY_INPUT = s.tuple([batteryLevel, s.string({ max: 32 }).optional()]);

onNet('mica:server:admin:setBattery', (...args: unknown[]) => {
  // Rate limit, parse and authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got none of the three until this; see `lib/netGuard.ts`. The parse comes
  // before the admin check, so a non-admin sending garbage is dropped rather than toasted.
  const guarded = guardNetEvent('admin', 'setBattery', SET_BATTERY_INPUT, args);
  if (!guarded) return;
  const [level, rawDevice] = guarded.input;
  // A device this server does not know, or has off, is dropped rather than read as the phone:
  // a slider that meant the tablet must not move the phone's charge.
  const device = rawDevice === undefined ? DEFAULT_DEVICE : rawDevice;
  if (!isDeviceId(device) || !isDeviceEnabled(device)) return;

  const src = source;
  if (!isAdmin(src)) {
    notifyPlayer(src, {
      type: 'error',
      message: 'You do not have permission to do that.',
      key: 'server.battery.noPermission'
    });
    return;
  }

  // Through `setBatteryLevel` and so `applyCharge`, like `micacharge` and the battery bank: a
  // bare save-and-push left the live charge the drain loop ticks from untouched, so the next
  // whole percent pushed the old level straight back over the slider. `setBatteryLevel` also
  // refuses a tablet the admin has none of, rather than seeding a charge that would tick for a
  // device that is not there. The phone's path runs synchronously, as it always did.
  void setBatteryLevel(src, level, device).catch((error: unknown) => {
    console.error(`[mica] battery slider for source ${src} threw`, error);
  });
});

/**
 * Forget one device's live state for a source, leaving its other devices alone: a device that
 * is off, or that the player no longer holds, has nothing to tick.
 */
const dropDevice = (src: number, device: DeviceId): void => {
  charge[device].delete(src);
  loadFailed[device].delete(src);
  loadToken[device].delete(src);
  phoneOf[device].delete(src);
};

/**
 * Send a player one device's saved charge — the phone's unless `device` names another.
 *
 * Our table first. Framework metadata is only consulted when the phone has no row yet, so a
 * player who had a charge before this table existed keeps it — and that read is written
 * straight back, so the fallback runs exactly once per character. A tablet has no such past
 * (MICA-337): no row is a full battery.
 */
export const sendLoadedBatteryToClient = async (
  src: number,
  device: DeviceId = DEFAULT_DEVICE
): Promise<void> => {
  // A device this server has off holds nothing. `mica_tablet` is read live, so a tablet
  // switched off under a running resource stops ticking at its next load.
  if (!isDeviceEnabled(device)) {
    dropDevice(src, device);
    return;
  }

  const player = FrameworkBridge.getPlayer(src);
  const citizenid = player?.citizenid;

  // No loaded character yet — a multichar player still at the selection screen. Nothing
  // to look up, and `src_<id>` would key a row to a source number that gets reused. The phone
  // is told a full battery, as it always was; any other device holds nothing (MICA-337), since
  // with no character there is no inventory to be holding one in.
  if (!citizenid) {
    if (device !== DEFAULT_DEVICE) {
      dropDevice(src, device);
      return;
    }
    charge[device].set(src, 100);
    pushCharge(src, device, 100);
    return;
  }

  // This load's token (`loadToken`). Taken before the first await; after every await, a load
  // that is no longer the current one — superseded by a set, a newer load or a disconnect —
  // stops without touching anything, because what it read may already be stale.
  const token = {};
  loadToken[device].set(src, token);
  const superseded = (): boolean => loadToken[device].get(src) !== token;

  // Unknown is not "no row" (MICA-326), and that holds for the device as much as the charge.
  const failed = (what: string, error: unknown, keepCharge: boolean): void => {
    loadToken[device].delete(src);
    loadFailed[device].set(src, LOAD_RETRY_TICKS);
    if (!keepCharge) charge[device].delete(src);
    console.error(
      `[mica] failed to ${what} for source ${src}; nothing was written. Retrying in about a ` +
        `minute, or sooner on a device-state change.`,
      error
    );
    const known = charge[device].get(src);
    if (known !== undefined) pushCharge(src, device, Math.round(known));
  };

  // The device in hand (MICA-283, per device since MICA-337). Holding none on a gated server
  // means there is no charge to show and nothing to tick: the device is closed for them anyway.
  let phone: string | null;
  try {
    phone = await phoneForSource(src, citizenid, device);
  } catch (e) {
    if (superseded()) return;
    // `phoneForSource` answers a known device without asking anything, so a throw means none
    // was known: whatever charge is held is not this device's.
    failed(`resolve the ${device} for the battery`, e, false);
    return;
  }
  if (superseded()) return;
  if (!phone) {
    loadToken[device].delete(src);
    charge[device].delete(src);
    // Picked up later, it is loaded then (`heldNone`). A tablet not yet in use is not "held
    // none": the tick loads it once it has an identity.
    if (device === DEFAULT_DEVICE) heldNone[device].set(src, true);
    return;
  }
  heldNone[device].delete(src);
  // Whether the live charge, if any, is already this device's — a reload of the same one,
  // rather than a first load or a switch, where it is nobody's or the previous device's.
  const samePhone = phoneOf[device].get(src) === phone;
  // Recorded before the lookup, so a disconnect knows which cache entry to forget even if
  // this device's charge never moves far enough to be written.
  phoneOf[device].set(src, phone);

  let savedCharge: number | null = null;
  try {
    const [row] = await batteryApp.repo.findAll({ phone_id: phone } as Partial<PhoneBattery>);
    if (row) savedCharge = Number(row.level);
  } catch (e) {
    if (superseded()) return;
    // Falling through to the default would save it, and a saved 12% would come back as 100
    // after one transient error. So: write nothing, keep the last charge known for this device
    // or hold none, and retry — see `loadFailed`. With none held the loop does not tick this
    // source, so nothing saves a guess behind our back either, and the battery bank refuses
    // (`batteryItemUsed`); the device keeps showing what it showed.
    failed(`load the ${device} battery`, e, samePhone);
    return;
  }
  if (superseded()) return;
  loadFailed[device].delete(src);

  if (savedCharge === null) {
    // Legacy metadata is the phone's alone: it predates the tablet having a battery at all.
    const metadata = device === DEFAULT_DEVICE ? player.rawPlayer?.PlayerData?.metadata : null;
    const legacy = metadata?.mica_battery ?? metadata?.phone_battery;
    savedCharge = legacy === undefined ? 100 : Number(legacy);
    // Adopt it, so the next load reads our table. Awaited rather than fired and
    // forgotten: a `loadBattery` racing the drain loop's first `saveBattery` could
    // otherwise both see no row and both insert.
    await savePlayerBattery(src, savedCharge, device, phone);
    if (superseded()) return;
  }
  loadToken[device].delete(src);

  if (!Number.isFinite(savedCharge)) savedCharge = 100;
  // Seed the live value, not just the device. The loop ticks from this map, so a load that
  // only told the client would leave the server ticking down from 100 for somebody whose
  // saved charge is 12.
  charge[device].set(src, savedCharge);
  pushCharge(src, device, savedCharge);
};

/**
 * Answer `battery:load` for every device this server has on (MICA-337): the phone always, the
 * tablet unless `mica_tablet` is off — and then only once it is in use. Each load is its own
 * failure, as each device is its own battery: a tablet whose row cannot be read must not stop
 * the phone's charge arriving.
 */
const loadEnabledDevices = async (src: number): Promise<void> => {
  knownSources.add(src);
  const outcomes = await Promise.allSettled(
    enabledDevices().map((device) => {
      if (device === DEFAULT_DEVICE) return sendLoadedBatteryToClient(src, device);
      // Lazily (MICA-337): a charge already held is answered as it is, and one not yet loaded
      // is loaded only for a device already in use. Nothing here gives a tablet an identity.
      const held = charge[device].get(src);
      if (held !== undefined) {
        pushCharge(src, device, Math.round(held));
        return Promise.resolve();
      }
      if (deviceInUse(src, device) === null) return Promise.resolve();
      return sendLoadedBatteryToClient(src, device);
    })
  );
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  if (rejected) throw rejected.reason;
};

// Event for client to request saved battery level on spawn / join: one answer per device.
onNet('mica:server:battery:load', (...args: unknown[]) => {
  if (!guardNetEvent('battery', 'load', noInput, args)) return;

  const src = source;
  void loadEnabledDevices(src).catch((error: unknown) => {
    console.error(`[mica] battery load for source ${src} threw`, error);
  });
});

/**
 * Seed the live value from the table when a character loads.
 *
 * Without this the loop has nothing to tick, and `currentCharge` would answer 100 for a
 * player whose saved charge is 12.
 *
 * One subscription, where there used to be a listener per framework event. This one had the
 * widest blast radius of the three MICA-136 fixed: a payload naming a third party made the
 * server read their row, possibly write it, and overwrite their live `charge` — and an id
 * belonging to nobody seeded `charge`/`ownerOf` with an entry `playerDropped` would never
 * come back for. `lib/shell.ts` now owns every player-loaded entry point and this is handed a
 * source already established from the connection, so there is no payload here to get wrong.
 *
 * Returned rather than `void`-ed: the registry catches a rejection and names this subscriber,
 * where a swallowed one would be an unhandled rejection with nothing pointing at battery.
 */
onPlayerLoaded('battery', (src) => {
  // A character load on a source that is already connected is a character **switch** — a
  // multichar logout and pick, with no `playerDropped` between. Everything held for this
  // source belonged to the previous character: `phoneOf` above all, which `phoneForSource`
  // answers from without asking, so the new character would have loaded, ticked and saved
  // the previous character's phone — and tablet. Forgotten first, every device, exactly as a
  // disconnect forgets it.
  forgetSource(src);
  knownSources.add(src);
  // Only the phone at a character load (MICA-337). Any other device's cached id is still the
  // previous character's until `services/Phones.ts` re-resolves — on this same load, but
  // asynchronously — so it is marked stale here and the tick loads the device once its id is
  // this character's. A first load has nothing cached, and marks nothing.
  for (const device of ALL_DEVICES) {
    if (device === DEFAULT_DEVICE) continue;
    const previous = activeDeviceIdOf(src, device);
    if (previous !== null) staleIdentity[device].set(src, previous);
  }
  return sendLoadedBatteryToClient(src, DEFAULT_DEVICE);
});

/**
 * The device in hand may have changed (MICA-283; any device since MICA-337): the live charge
 * belongs to the old one, so it is saved there, and the new one's charge is loaded in its
 * place. Fired on load too, where `phoneOf` is still empty and the `onPlayerLoaded` subscriber
 * above is the one doing the loading — so an empty `phoneOf` is left to it rather than loaded
 * twice, unless that load already ran and found none in hand (`heldNone`): then this is the
 * device being picked up, and nothing else would load it.
 */
const switchBatteryDevice = async (src: number, device: DeviceId): Promise<void> => {
  const previous = phoneOf[device].get(src);
  if (!previous) {
    const pickedUp = heldNone[device].delete(src);
    const inUse = device !== DEFAULT_DEVICE && deviceInUse(src, device) !== null;
    if (pickedUp || inUse) await sendLoadedBatteryToClient(src, device);
    return;
  }

  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return;

  // Whether this switch still speaks for the source once its await returns. A character load
  // or a disconnect forgets `phoneOf`, and a concurrent switch moves it; either way the charge
  // held now is not `previous`'s to save, and the load is somebody else's to make.
  const stale = (): boolean => phoneOf[device].get(src) !== previous;
  // Only a charge actually held is saved. After a failed load there may be none, and
  // `currentCharge` would answer 100 for it — the overwrite MICA-326 removed from the load.
  const held = (): boolean => charge[device].has(src);

  let next: string | null;
  try {
    next = await phoneForRequest(src, player.citizenid, device);
  } catch (error) {
    if (!(error instanceof PlayerFacingError)) throw error;
    if (stale()) return;
    // Holding none now. The old device's charge is saved and nothing ticks until one is in
    // hand again — and then it is loaded (`heldNone`).
    if (held()) await savePlayerBattery(src, currentCharge(src, device), device, previous);
    dropDevice(src, device);
    heldNone[device].set(src, true);
    return;
  }
  if (stale()) return;
  if (next === previous) {
    // The same device, so nothing to switch — but a load that could not read the table is
    // owed a retry, and this is the next occasion (MICA-326). Claimed by deleting the mark, so
    // a second event while this retry is in flight does not start another; a retry that fails
    // again puts it back.
    if (loadFailed[device].delete(src)) await sendLoadedBatteryToClient(src, device);
    return;
  }

  if (held()) await savePlayerBattery(src, currentCharge(src, device), device, previous);
  phoneOf[device].delete(src);
  // The charge held is `previous`'s and has just been saved there. Left in the map, a tick that
  // crossed a whole percent while the new device's row was being read saved it — through the
  // `phoneOf` the load had already moved — into the *new* device's row, and a read that then
  // failed left it there for good. Nothing is held until the new device's load says what it is.
  charge[device].delete(src);
  await sendLoadedBatteryToClient(src, device);
};

onPhoneStateChanged('battery', (src) => switchBatteryDevice(src, DEFAULT_DEVICE));

/**
 * Every other device's twin of the line above (MICA-337): `deviceItem.ts` tells this hook about
 * the tablet — on a load, an inventory change and a use of its item — and never about the
 * phone, so the two subscriptions never load one device twice.
 */
onDeviceStateChanged('battery', (src, device) => switchBatteryDevice(src, device));

/**
 * Out-of-band recharge: `micacharge [playerId] <0-100>`.
 *
 * Until now the only way to add charge was the `battery_bank` item, so a flat battery
 * with no item in your inventory meant a phone that could not be turned on — and the
 * Developer Tools that would have fixed it live inside the phone.
 *
 * Runnable from the server console or by anyone `isAdmin` accepts. Restricted rather
 * than open because it writes another player's saved charge.
 */
/** Report back on whichever channel the caller used. */
const respond = (source: number, message: string, isError = false) => {
  if (source === 0) {
    console.log(`[mica] ${message}`);
    return;
  }
  notifyPlayer(source, {
    type: isError ? 'error' : 'success',
    message
  });
};

export const runChargeCommand = (source: number, args: string[]): void => {
  // Routed through `isAdmin` rather than repeating an ace check. The inline
  // `IsPlayerAceAllowed(..., 'mica.admin')` this replaces did not learn about the
  // wider admin list, so a full server admin was refused by a command that then said
  // nothing, because the denial notify had no client listener at the time.
  if (!isAdmin(source)) {
    respond(source, 'You do not have permission to use that.', true);
    return;
  }

  const fromConsole = source === 0;
  // Console must name a target; a player defaults to themselves.
  const target = args.length > 1 ? parseInt(args[0], 10) : fromConsole ? NaN : source;
  const rawLevel = args.length > 1 ? args[1] : args[0];
  const level = Math.max(0, Math.min(100, Number(rawLevel)));

  if (!Number.isInteger(target) || target <= 0) {
    respond(source, 'usage: micacharge <playerId> <0-100>', true);
    return;
  }
  if (rawLevel === undefined || !Number.isFinite(Number(rawLevel))) {
    respond(source, 'usage: micacharge [playerId] <0-100>', true);
    return;
  }

  // Through `applyCharge`, not a bare save-and-push. Writing the row and telling the
  // phone leaves out the third place the number lives: the `charge` map the server's own
  // drain loop ticks from. The phone showed 100 and the very next tick pushed the old
  // level straight back over it, having never heard about this command.
  const applied = applyCharge(target, level);
  respond(source, `battery for ${target} set to ${applied}%`);
};

RegisterCommand(
  'micacharge',
  (source: number, args: string[]) => runChargeCommand(source, args),
  false
);

/**
 * Using the item recharges the open device, else the phone (MICA-337).
 *
 * "Open" is the server's mirror of the client's own state (`PhoneOpenState`, per device since
 * MICA-263): a player looking at their tablet who uses a battery bank means the tablet. The
 * phone is the answer otherwise — with the phone open, with nothing open, and with a tablet
 * this server has switched off, whose open state is stale by definition.
 *
 * Through `applyCharge`, not a bare push. The charge lives in three places — the map the
 * drain loop ticks, the phone, and the table — and this used to set only the phone: the
 * very next tick pushed the old low level straight back over the 100 the player had just
 * paid an item for. It is the identical trap `micacharge` was pulled out of, and the reason
 * `applyCharge` exists at all.
 *
 * The name is captured at registration rather than read again here, so the item the
 * framework calls us for is the item we charge for even if the convar is changed underneath
 * a running resource.
 */
const bankTarget = (src: number): DeviceId =>
  isDeviceEnabled('tablet') && isDeviceOpen(src, 'tablet') ? 'tablet' : DEFAULT_DEVICE;

const batteryItemUsed = (src: number, item: string): void => {
  const device = bankTarget(src);
  // No charge held — a load that could not read the table, or none of that device in hand — so
  // there is nothing to add to: `currentCharge` would answer 100 and the bank would write that
  // over the saved charge (MICA-326). Refused before the item is touched, so the player keeps
  // it — and told, because using an item that silently does nothing reads as a broken item.
  // Not passed on to the phone when it is the open tablet that cannot take it: the player is
  // looking at the tablet, and charging a device they did not mean spends the item behind
  // their back.
  if (!charge[device].has(src)) {
    const label = DEVICES[device].label;
    notifyPlayer(src, {
      type: 'error',
      message: `Your ${label.toLowerCase()} can't be charged right now. The battery bank was not used.`,
      key: 'server.battery.unavailable',
      params: { device: label }
    });
    return;
  }
  if (!removeBatteryItem(src, item)) return;
  applyCharge(src, currentCharge(src, device) + batteryItemCharge(), device);
};

const configuredBatteryItem = batteryItemName();
if (configuredBatteryItem) {
  FrameworkBridge.registerUsableItem(configuredBatteryItem, (src: number) =>
    batteryItemUsed(src, configuredBatteryItem)
  );
}

/**
 * Read a player's saved charge, for the public API.
 *
 * From the table rather than from the client's in-memory value: an export must answer the
 * same number a reconnect would restore, and the drain loop only reports every 15 seconds.
 *
 * **Rejects on a read error** rather than answering 100 (MICA-326). The export contract has
 * an answer for "micaOS could not find out" — `guardedAsync` logs the throw and the caller
 * reads `{ ok: false, reason: 'internal_error' }` — and a full battery is not it: a caller
 * gating on charge would act on a number nobody read, and `AddBatteryCharge` would add its
 * delta to that 100 and *write* the result over the saved charge. No row is still 100, the
 * same default the column and a first load use.
 */
export const getBatteryLevel = async (
  citizenid: string,
  device: DeviceId = DEFAULT_DEVICE,
  src?: number
): Promise<number | null> => {
  const phone = await batteryDeviceOf(citizenid, device, src);
  if (!phone) return null;
  const [row] = await batteryApp.repo.findAll({ phone_id: phone } as Partial<PhoneBattery>);
  return row ? Number(row.level) : 100;
};

/**
 * The device an export's charge belongs to, or `null` for none.
 *
 * The phone: the one this citizen is on — in hand, else last used, else their identity phone —
 * so the export answers for the phone a reconnect would restore (MICA-283). Never `null`.
 *
 * Any other device (MICA-337): the one this source's live charge belongs to, else the one in
 * their hand, through the same `phoneForRequest` a tablet request is scoped by. `null` for a
 * player holding none on a gated server, which the export reports rather than reading or
 * writing a row for a tablet they do not have — and for a call with no source, since there is
 * no citizen-level "last tablet" to fall back on.
 */
const batteryDeviceOf = async (
  citizenid: string,
  device: DeviceId,
  src: number | undefined
): Promise<string | null> => {
  if (device === DEFAULT_DEVICE) return phoneForCitizen(citizenid);
  if (src === undefined) return null;
  return phoneForSource(src, citizenid, device);
};

/**
 * Set a player's charge, from the server to the phone and to the table.
 *
 * Both halves, deliberately. Writing only the row leaves the running phone showing the old
 * charge until the next reconnect; pushing only to the client loses it on a crash — which
 * is the exact failure that moved saved charge out of framework metadata in the first
 * place. Returns the clamped level so a caller sees what actually happened rather than
 * what it asked for.
 */
export const setBatteryLevel = async (
  src: number,
  level: number,
  device: DeviceId = DEFAULT_DEVICE
): Promise<number | null> => {
  // The phone's path is what it always was: straight to the authoritative value, even for a
  // player holding no phone (MICA-337 changes nothing an existing caller sees). Another device
  // is refused for a player holding none of it — an `ok` for a tablet that does not exist
  // would be a charge nothing shows and nothing saves.
  if (device !== DEFAULT_DEVICE) {
    const citizenid = FrameworkBridge.getPlayer(src)?.citizenid;
    if (!citizenid) return null;
    if (!(await batteryDeviceOf(citizenid, device, src))) return null;
  }
  // Straight to the authoritative value. Nothing to reconcile with a client timer any
  // more, which is what the old comment about resynchronising a drifted phone was for.
  return applyCharge(src, level, device);
};

/**
 * Charging, held here and mirrored to the client so the phone can show it.
 *
 * State rather than an event: the drain loop moves the charge a fraction of a percent every
 * tick, so charging has to reverse *that* rather than race it with repeated top-ups from
 * outside.
 *
 * The flag is held here, keyed by source, because the drain loop that reads it is the
 * server's. That makes it exactly the kind of per-source state a reused server id inherits,
 * so `playerDropped` clears it — a charger left plugged in would otherwise charge the phone
 * of whoever lands on that id next, at ten percent a minute, from nothing they did.
 */
export const setCharging = (
  src: number,
  isCharging: boolean,
  device: DeviceId = DEFAULT_DEVICE
): boolean => {
  // Refused for a device other than the phone that this source has none of (MICA-337), as
  // `SetBatteryLevel` is: a flag for a tablet that does not exist charges nothing anyone sees.
  if (!hasBatteryDevice(src, device)) return false;
  // The loop is server-side now, so this flips a flag the loop reads rather than pushing a
  // state the client's own timer had to honour. One flag per device (MICA-337): a tablet on a
  // charger says nothing about the phone in the player's pocket.
  if (isCharging) charging[device].set(src, true);
  else charging[device].delete(src);
  if (typeof emitNet !== 'function') return true;
  // The phone's push is the bare flag it has always been; another device appends its id.
  if (device === DEFAULT_DEVICE) emitNet('mica:client:battery:charging', src, isCharging);
  else emitNet('mica:client:battery:charging', src, isCharging, device);
  return true;
};
