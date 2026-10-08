// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The server half of the battery service.
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
  onPhoneStateChanged
} from '../lib/deviceItem';
import { phoneForCitizen, phoneForRequest } from '../lib/phoneIdentity';
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
  // The charge is the phone's (MICA-283): two phones hold two charges, and a battery bank
  // charges the one in hand.
  deviceOwned: true,
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
const phoneOf = new Map<number, string>();

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
const loadFailed = new Map<number, number>();

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
const loadToken = new Map<number, object>();

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
const charge = new Map<number, number>();
const charging = new Set<number>();

/** Percent per minute. Draining is slow; a charger should visibly beat it. */
const DRAIN_PER_MINUTE = 1;
const CHARGE_PER_MINUTE = 10;
const TICK_MS = 5000;
/** About once a minute: a failed load retried every tick would hammer a database already in trouble. */
const LOAD_RETRY_TICKS = Math.round(60_000 / TICK_MS);

const pushCharge = (src: number, level: number): void => {
  if (typeof emitNet === 'function') emitNet('mica:client:battery:set', src, level);
};

/**
 * One tick for every connected player.
 *
 * Whole percents are what the phone shows, so a push and a write happen only when the
 * rounded value moves — once a minute while draining, not every five seconds. That is the
 * saving the client's `saveCounter` was reaching for, expressed where the number lives.
 */
const tickBattery = (): void => {
  for (const [src, level] of charge) {
    const rate = charging.has(src) ? CHARGE_PER_MINUTE : -DRAIN_PER_MINUTE;
    const next = Math.max(0, Math.min(100, level + (rate * TICK_MS) / 60_000));
    if (next === level) continue;

    charge.set(src, next);
    if (Math.round(next) !== Math.round(level)) {
      pushCharge(src, Math.round(next));
      void savePlayerBattery(src, Math.round(next));
    }
  }

  // Loads that could not read the table (MICA-326). Claimed by deleting the entry, so the next
  // tick cannot start a second retry while this one is in flight.
  for (const [src, ticks] of loadFailed) {
    if (ticks > 1) {
      loadFailed.set(src, ticks - 1);
      continue;
    }
    loadFailed.delete(src);
    void sendLoadedBatteryToClient(src).catch((error: unknown) => {
      console.error(`[mica] battery load retry for source ${src} threw`, error);
    });
  }
};

if (typeof setInterval === 'function') setInterval(tickBattery, TICK_MS);

/** Test seams: module state and a deterministic tick, rather than waiting on wall clock. */
export const __tickBattery = tickBattery;
export const __resetBatteryState = (): void => {
  charge.clear();
  charging.clear();
  phoneOf.clear();
  lastWritten.clear();
  loadFailed.clear();
  loadToken.clear();
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
  charge.delete(src);
  charging.delete(src);
  loadFailed.delete(src);
  loadToken.delete(src);

  const phoneId = phoneOf.get(src);
  if (phoneId !== undefined) lastWritten.delete(phoneId);
  phoneOf.delete(src);
};

on('playerDropped', () => {
  forgetSource(source);
});

/** What the server believes this player's charge is. */
export const currentCharge = (src: number): number => Math.round(charge.get(src) ?? 100);

/** Set the live value, tell the phone, and persist. The one way charge changes outright. */
export const applyCharge = (src: number, level: number): number => {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  charge.set(src, clamped);
  loadFailed.delete(src);
  loadToken.delete(src);
  pushCharge(src, clamped);
  void savePlayerBattery(src, clamped);
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
 * The phone a source's charge belongs to: the one already recorded for it, else the one in
 * its hand. `null` for a player holding no phone on a gated server — there is nothing for a
 * charge to belong to, and `phoneForRequest` says so as a `PlayerFacingError`, which is not
 * an error here but an answer.
 */
const phoneForSource = async (src: number, citizenid: string): Promise<string | null> => {
  const known = phoneOf.get(src);
  if (known) return known;
  try {
    return await phoneForRequest(src, citizenid);
  } catch (error) {
    if (error instanceof PlayerFacingError) return null;
    throw error;
  }
};

/**
 * Persist a charge to a phone. Returns silently for a source with no loaded character, and
 * for one holding no phone.
 *
 * `phoneId` names the phone explicitly when the caller knows better than the cache — the
 * switch saves the *old* phone's charge after `phoneOf` has already moved on.
 */
export const savePlayerBattery = async (
  src: number,
  level: number,
  phoneId?: string
): Promise<void> => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return;

  const { citizenid } = player;
  const phone = phoneId ?? (await phoneForSource(src, citizenid));
  if (!phone) return;
  if (!phoneId) phoneOf.set(src, phone);

  const safeLevel = Math.max(0, Math.min(100, Math.round(level)));
  if (lastWritten.get(phone) === safeLevel) return;
  rememberWrite(phone, safeLevel);

  // Mirrored into character metadata so other resources reading `mica_battery` keep
  // working. Our table is the authority; this is a courtesy copy — of the phone in hand.
  player.setMeta('mica_battery', safeLevel);

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
const SET_BATTERY_INPUT = s.tuple([batteryLevel]);

onNet('mica:server:admin:setBattery', (...args: unknown[]) => {
  // Rate limit, parse and authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got none of the three until this; see `lib/netGuard.ts`. The parse comes
  // before the admin check, so a non-admin sending garbage is dropped rather than toasted.
  const guarded = guardNetEvent('admin', 'setBattery', SET_BATTERY_INPUT, args);
  if (!guarded) return;
  const [level] = guarded.input;

  const src = source;
  if (!isAdmin(src)) {
    notifyPlayer(src, {
      type: 'error',
      message: 'You do not have permission to do that.',
      key: 'server.battery.noPermission'
    });
    return;
  }

  void savePlayerBattery(src, level);
  emitNet('mica:client:battery:set', src, level);
});

/**
 * Send a player their saved charge.
 *
 * Our table first. Framework metadata is only consulted when there is no row yet, so a
 * player who had a charge before this table existed keeps it — and that read is written
 * straight back, so the fallback runs exactly once per character.
 */
export const sendLoadedBatteryToClient = async (src: number): Promise<void> => {
  const player = FrameworkBridge.getPlayer(src);
  const citizenid = player?.citizenid;

  // No loaded character yet — a multichar player still at the selection screen. Nothing
  // to look up, and `src_<id>` would key a row to a source number that gets reused.
  if (!citizenid) {
    charge.set(src, 100);
    emitNet('mica:client:battery:set', src, 100);
    return;
  }

  // This load's token (`loadToken`). Taken before the first await; after every await, a load
  // that is no longer the current one — superseded by a set, a newer load or a disconnect —
  // stops without touching anything, because what it read may already be stale.
  const token = {};
  loadToken.set(src, token);
  const superseded = (): boolean => loadToken.get(src) !== token;

  // Unknown is not "no row" (MICA-326), and that holds for the phone as much as the charge.
  const failed = (what: string, error: unknown, keepCharge: boolean): void => {
    loadToken.delete(src);
    loadFailed.set(src, LOAD_RETRY_TICKS);
    if (!keepCharge) charge.delete(src);
    console.error(
      `[mica] failed to ${what} for source ${src}; nothing was written. Retrying in about a ` +
        `minute, or sooner on a phone-state change.`,
      error
    );
    const known = charge.get(src);
    if (known !== undefined) emitNet('mica:client:battery:set', src, Math.round(known));
  };

  // The phone in hand (MICA-283). Holding none on a gated server means there is no charge
  // to show and nothing to tick: the phone is closed for them anyway.
  let phone: string | null;
  try {
    phone = await phoneForSource(src, citizenid);
  } catch (e) {
    if (superseded()) return;
    // `phoneForSource` answers a known phone without asking anything, so a throw means none
    // was known: whatever charge is held is not this phone's.
    failed('resolve the phone for the battery', e, false);
    return;
  }
  if (superseded()) return;
  if (!phone) {
    loadToken.delete(src);
    charge.delete(src);
    return;
  }
  // Whether the live charge, if any, is already this phone's — a reload of the same phone,
  // rather than a first load or a switch, where it is nobody's or the previous phone's.
  const samePhone = phoneOf.get(src) === phone;
  // Recorded before the lookup, so a disconnect knows which cache entry to forget even if
  // this phone's charge never moves far enough to be written.
  phoneOf.set(src, phone);

  let savedCharge: number | null = null;
  try {
    const [row] = await batteryApp.repo.findAll({ phone_id: phone } as Partial<PhoneBattery>);
    if (row) savedCharge = Number(row.level);
  } catch (e) {
    if (superseded()) return;
    // Falling through to the default would save it, and a saved 12% would come back as 100
    // after one transient error. So: write nothing, keep the last charge known for this phone
    // or hold none, and retry — see `loadFailed`. With none held the loop does not tick this
    // source, so nothing saves a guess behind our back either, and the battery bank refuses
    // (`batteryItemUsed`); the phone keeps showing what it showed.
    failed('load battery', e, samePhone);
    return;
  }
  if (superseded()) return;
  loadFailed.delete(src);

  if (savedCharge === null) {
    const metadata = player.rawPlayer?.PlayerData?.metadata;
    const legacy = metadata?.mica_battery ?? metadata?.phone_battery;
    savedCharge = legacy === undefined ? 100 : Number(legacy);
    // Adopt it, so the next load reads our table. Awaited rather than fired and
    // forgotten: a `loadBattery` racing the drain loop's first `saveBattery` could
    // otherwise both see no row and both insert.
    await savePlayerBattery(src, savedCharge, phone);
    if (superseded()) return;
  }
  loadToken.delete(src);

  if (!Number.isFinite(savedCharge)) savedCharge = 100;
  // Seed the live value, not just the phone. The loop ticks from this map, so a load that
  // only told the client would leave the server ticking down from 100 for somebody whose
  // saved charge is 12.
  charge.set(src, savedCharge);
  emitNet('mica:client:battery:set', src, savedCharge);
};

// Event for client to request saved battery level on spawn / join
onNet('mica:server:battery:load', (...args: unknown[]) => {
  if (!guardNetEvent('battery', 'load', noInput, args)) return;

  void sendLoadedBatteryToClient(source);
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
  // the previous character's phone. Forgotten first, exactly as a disconnect forgets it.
  forgetSource(src);
  return sendLoadedBatteryToClient(src);
});

/**
 * The phone in hand may have changed (MICA-283): the live charge belongs to the old phone,
 * so it is saved there, and the new phone's charge is loaded in its place. Fired on load
 * too, where `phoneOf` is still empty and the `onPlayerLoaded` subscriber above is the one
 * doing the loading — so an empty `phoneOf` is left to it rather than loaded twice.
 */
const switchBatteryPhone = async (src: number): Promise<void> => {
  const previous = phoneOf.get(src);
  if (!previous) return;

  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return;

  // Whether this switch still speaks for the source once its await returns. A character load
  // or a disconnect forgets `phoneOf`, and a concurrent switch moves it; either way the charge
  // held now is not `previous`'s to save, and the load is somebody else's to make.
  const stale = (): boolean => phoneOf.get(src) !== previous;
  // Only a charge actually held is saved. After a failed load there may be none, and
  // `currentCharge` would answer 100 for it — the overwrite MICA-326 removed from the load.
  const held = (): boolean => charge.has(src);

  let next: string | null;
  try {
    next = await phoneForRequest(src, player.citizenid);
  } catch (error) {
    if (!(error instanceof PlayerFacingError)) throw error;
    if (stale()) return;
    // Holding no phone now. The old phone's charge is saved and nothing ticks until a phone is
    // in hand again.
    if (held()) await savePlayerBattery(src, currentCharge(src), previous);
    phoneOf.delete(src);
    charge.delete(src);
    loadFailed.delete(src);
    return;
  }
  if (stale()) return;
  if (next === previous) {
    // The same phone, so nothing to switch — but a load that could not read the table is
    // owed a retry, and this is the next occasion (MICA-326). Claimed by deleting the mark, so
    // a second event while this retry is in flight does not start another; a retry that fails
    // again puts it back.
    if (loadFailed.delete(src)) await sendLoadedBatteryToClient(src);
    return;
  }

  if (held()) await savePlayerBattery(src, currentCharge(src), previous);
  phoneOf.delete(src);
  // The charge held is `previous`'s and has just been saved there. Left in the map, a tick that
  // crossed a whole percent while the new phone's row was being read saved it — through the
  // `phoneOf` the load had already moved — into the *new* phone's row, and a read that then
  // failed left it there for good. Nothing is held until the new phone's load says what it is.
  charge.delete(src);
  await sendLoadedBatteryToClient(src);
};

onPhoneStateChanged('battery', (src) => switchBatteryPhone(src));

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
 * Using the item recharges the phone.
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
const batteryItemUsed = (src: number, item: string): void => {
  // No charge held — a load that could not read the table, or no phone in hand — so there is
  // nothing to add to: `currentCharge` would answer 100 and the bank would write that over the
  // saved charge (MICA-326). Refused before the item is touched, so the player keeps it — and
  // told, because using an item that silently does nothing reads as a broken item.
  if (!charge.has(src)) {
    notifyPlayer(src, {
      type: 'error',
      message: "Your phone can't be charged right now. The battery bank was not used.",
      key: 'server.battery.unavailable'
    });
    return;
  }
  if (!removeBatteryItem(src, item)) return;
  applyCharge(src, currentCharge(src) + batteryItemCharge());
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
export const getBatteryLevel = async (citizenid: string): Promise<number> => {
  // The phone this citizen is on — in hand, else last used, else their identity phone —
  // so the export answers for the phone a reconnect would restore (MICA-283).
  const phone = await phoneForCitizen(citizenid);
  const [row] = await batteryApp.repo.findAll({ phone_id: phone } as Partial<PhoneBattery>);
  return row ? Number(row.level) : 100;
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
export const setBatteryLevel = async (src: number, level: number): Promise<number> => {
  // Straight to the authoritative value. Nothing to reconcile with a client timer any
  // more, which is what the old comment about resynchronising a drifted phone was for.
  return applyCharge(src, level);
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
export const setCharging = (src: number, isCharging: boolean): void => {
  // The loop is server-side now, so this flips a flag the loop reads rather than pushing a
  // state the client's own timer had to honour.
  if (isCharging) charging.add(src);
  else charging.delete(src);
  if (typeof emitNet === 'function') emitNet('mica:client:battery:charging', src, isCharging);
};
