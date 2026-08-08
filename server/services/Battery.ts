// The server half of the battery service.
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { defineService } from '../lib/defineService';
import { PhoneBattery } from '@shared/types';
import { isAdmin } from './Admin';
import { notifyPlayer } from '../lib/shell';
import { guardNetEvent, levelFrom } from '../lib/netGuard';

/**
 * gPhone owns the saved charge, in its own table.
 *
 * It used to live only in framework character metadata, which is why it kept coming
 * back as 100%: metadata is held in memory and written to the `players` row when the
 * *framework* decides to save — logout, its autosave interval, a clean shutdown. A
 * server crash, an `ensure qbx_core`, or a restart between autosaves throws the value
 * away. The in-memory `playerBatteryStore` fallback was worse still: wiped by every
 * `ensure gphone`.
 *
 * No NUI surface: all four generic actions are off and the client reaches battery only
 * through the named events below. `write: 'server'` keeps the columns non-client-writable
 * on top of that.
 */
export const batteryApp = defineService<PhoneBattery>({
  id: 'battery',
  access: { read: 'owner', write: 'server' },
  schema: {
    level: { type: 'int', notNull: true, default: 100 }
  },
  // One row per player, enforced by the database rather than by a find-then-write that
  // can interleave with the 15-second drain save.
  indexes: [{ name: 'citizenid_unique', columns: ['citizenid'], unique: true }],
  options: {
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  }
});

/**
 * Last level written per citizenid.
 *
 * The drain loop reports every 15 seconds but only moves the charge 0.25% in that time,
 * so most reports are the same whole percent as the last. Skipping those turns four
 * writes per player per minute into one.
 */
const lastWritten = new Map<string, number>();

/** Test seam: the write-skip cache is module state that would leak between cases. */
export const __resetBatteryCache = () => lastWritten.clear();

/**
 * Charge per connected source, ticked by the server.
 *
 * This lived on the client: it ran the drain timer and reported over
 * `gphone:server:battery:save` every 15 seconds, so a modified client asserted whatever
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

const pushCharge = (src: number, level: number): void => {
  if (typeof emitNet === 'function') emitNet('gphone:client:battery:set', src, level);
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
};

if (typeof setInterval === 'function') setInterval(tickBattery, TICK_MS);

/** Test seams: module state and a deterministic tick, rather than waiting on wall clock. */
export const __tickBattery = tickBattery;
export const __resetBatteryState = (): void => {
  charge.clear();
  charging.clear();
  lastWritten.clear();
};

/** What the server believes this player's charge is. */
export const currentCharge = (src: number): number => Math.round(charge.get(src) ?? 100);

/** Set the live value, tell the phone, and persist. The one way charge changes outright. */
export const applyCharge = (src: number, level: number): number => {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  charge.set(src, clamped);
  pushCharge(src, clamped);
  void savePlayerBattery(src, clamped);
  return clamped;
};

// Helper to remove item from inventory
const removeBatteryBankItem = (src: number): boolean => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player) return true;
  return player.removeItem('battery_bank', 1);
};

/** Persist a player's charge. Returns silently for a source with no loaded character. */
export const savePlayerBattery = async (src: number, level: number): Promise<void> => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return;

  const { citizenid } = player;
  const safeLevel = Math.max(0, Math.min(100, Math.round(level)));
  if (lastWritten.get(citizenid) === safeLevel) return;
  lastWritten.set(citizenid, safeLevel);

  // Mirrored into character metadata so other resources reading `gphone_battery` keep
  // working. Our table is the authority; this is a courtesy copy.
  player.setMeta('gphone_battery', safeLevel);

  try {
    const [existing] = await batteryApp.repo.findAll({ citizenid } as Partial<PhoneBattery>);
    if (existing) {
      await batteryApp.repo.update(existing.id, { level: safeLevel }, citizenid);
    } else {
      await batteryApp.repo.create({ citizenid, level: safeLevel });
    }
  } catch (e) {
    // A failed write must not take the event handler down; the next report retries.
    lastWritten.delete(citizenid);
    console.error('[gphone] failed to save battery', e);
  }
};

// Event handler for battery_bank item or custom server trigger to recharge phone
onNet('gphone:server:battery:useItem', () => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('battery', 'useItem');
  if (!player) return;

  const src = source;
  const removed = removeBatteryBankItem(src);
  if (removed) {
    void savePlayerBattery(src, 100);
    emitNet('gphone:client:battery:recharge', src);
  }
});

/**
 * `gphone:server:battery:save` is deliberately absent.
 *
 * It let the client tell the server what its charge was, which is the whole of the
 * tampering surface — no amount of validating that payload makes it something else. The
 * server owns the number now, so there is nothing for the client to report.
 */

/**
 * The Developer Tools battery slider, gated on `gphone.admin`.
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
onNet('gphone:server:admin:setBattery', (rawCharge: unknown) => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('admin', 'setBattery');
  if (!player) return;

  const src = source;
  if (!isAdmin(src)) {
    notifyPlayer(src, {
      type: 'error',
      message: 'You do not have permission to do that.'
    });
    return;
  }

  const level = levelFrom(rawCharge);
  if (level === null) return;

  void savePlayerBattery(src, level);
  emitNet('gphone:client:battery:set', src, level);
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
    emitNet('gphone:client:battery:set', src, 100);
    return;
  }

  let savedCharge: number | null = null;
  try {
    const [row] = await batteryApp.repo.findAll({ citizenid } as Partial<PhoneBattery>);
    if (row) savedCharge = Number(row.level);
  } catch (e) {
    console.error('[gphone] failed to load battery', e);
  }

  if (savedCharge === null) {
    const metadata = player.rawPlayer?.PlayerData?.metadata;
    const legacy = metadata?.gphone_battery ?? metadata?.phone_battery;
    savedCharge = legacy === undefined ? 100 : Number(legacy);
    // Adopt it, so the next load reads our table. Awaited rather than fired and
    // forgotten: a `loadBattery` racing the drain loop's first `saveBattery` could
    // otherwise both see no row and both insert.
    await savePlayerBattery(src, savedCharge);
  }

  if (!Number.isFinite(savedCharge)) savedCharge = 100;
  // Seed the live value, not just the phone. The loop ticks from this map, so a load that
  // only told the client would leave the server ticking down from 100 for somebody whose
  // saved charge is 12.
  charge.set(src, savedCharge);
  emitNet('gphone:client:battery:set', src, savedCharge);
};

// Event for client to request saved battery level on spawn / join
onNet('gphone:server:battery:load', () => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('battery', 'load');
  if (!player) return;

  void sendLoadedBatteryToClient(source);
});

// Listen for QBX / QBCore character load events
/**
 * Seed the live value from the table when a character loads.
 *
 * Without this the loop has nothing to tick, and `currentCharge` would answer 100 for a
 * player whose saved charge is 12.
 */
on('QBCore:Server:OnPlayerLoaded', (player: any) => {
  const src = typeof player === 'number' ? player : player?.PlayerData?.source;
  if (src) {
    void sendLoadedBatteryToClient(src);
  }
});

// Listen for QBX core player loaded event
on('qbx_core:server:playerLoaded', (player: any) => {
  const src = typeof player === 'number' ? player : player?.PlayerData?.source;
  if (src) {
    void sendLoadedBatteryToClient(src);
  }
});

/**
 * Out-of-band recharge: `gphonecharge [playerId] <0-100>`.
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
    console.log(`[gphone] ${message}`);
    return;
  }
  notifyPlayer(source, {
    type: isError ? 'error' : 'success',
    message
  });
};

export const runChargeCommand = (source: number, args: string[]): void => {
  // Routed through `isAdmin` rather than repeating an ace check. The inline
  // `IsPlayerAceAllowed(..., 'gphone.admin')` this replaces did not learn about the
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
    respond(source, 'usage: gphonecharge <playerId> <0-100>', true);
    return;
  }
  if (rawLevel === undefined || !Number.isFinite(Number(rawLevel))) {
    respond(source, 'usage: gphonecharge [playerId] <0-100>', true);
    return;
  }

  void savePlayerBattery(target, level);
  emitNet('gphone:client:battery:set', target, level);
  respond(source, `battery for ${target} set to ${level}%`);
};

RegisterCommand(
  'gphonecharge',
  (source: number, args: string[]) => runChargeCommand(source, args),
  false
);

// Register usable item with framework
FrameworkBridge.registerUsableItem('battery_bank', (source: number) => {
  const removed = removeBatteryBankItem(source);
  if (removed) {
    emitNet('gphone:client:battery:recharge', source);
  }
});

/**
 * Read a player's saved charge, for the public API.
 *
 * From the table rather than from the client's in-memory value: an export must answer the
 * same number a reconnect would restore, and the drain loop only reports every 15 seconds.
 */
export const getBatteryLevel = async (citizenid: string): Promise<number> => {
  try {
    const [row] = await batteryApp.repo.findAll({ citizenid } as Partial<PhoneBattery>);
    return row ? Number(row.level) : 100;
  } catch (e) {
    console.error('[gphone] failed to read battery', e);
    return 100;
  }
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
 * Charging, pushed to the client and held there.
 *
 * State rather than an event: the drain loop lives on the client and moves the charge
 * 0.25% every 15 seconds, so charging has to reverse *that* rather than race it with
 * repeated top-ups from outside.
 *
 * Deliberately no server-side copy. The first version kept a `Set<source>` and cleared it
 * on `playerDropped`, reasoning that FiveM reuses server ids — but that reasoning belongs
 * to the rate limiter, not here. The flag lives in the client bundle, which is per player
 * and gone when they disconnect, so a set here would have been write-only state guarding
 * against a problem that cannot happen. Add one back only alongside a `GetCharging` that
 * needs to read it.
 */
export const setCharging = (src: number, isCharging: boolean): void => {
  // The loop is server-side now, so this flips a flag the loop reads rather than pushing a
  // state the client's own timer had to honour.
  if (isCharging) charging.add(src);
  else charging.delete(src);
  if (typeof emitNet === 'function') emitNet('gphone:client:battery:charging', src, isCharging);
};
