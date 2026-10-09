// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import {
  ALL_DEVICES,
  DEFAULT_DEVICE,
  DEVICES,
  isDeviceId,
  type DeviceId
} from '@mica/shared/devices';
import { Database } from '../lib/Database';
import { defineService, phoneKeyedRepositories } from '../lib/defineService';
import { PlayerFacingError } from '../lib/errors';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import type { FrameworkPlayer } from '../lib/framework/runtime';
import { installPhoneResolvers } from '../lib/phoneIdentity';
import {
  deviceItemName,
  holdsDevice,
  isDeviceEnabled,
  lastUsedDeviceSlot,
  onDeviceStateChanged
} from '../lib/deviceItem';

/**
 * The phone as a thing with an identity of its own (MICA-280, on MICA-279's seam), and the
 * thing every device-owned row belongs to (MICA-282).
 *
 * **Why this is its own table rather than `mica_phone_numbers`.** The number table is what a
 * phone *has*; this is what a phone *is*. MICA-284 moved the number onto the phone, and
 * MICA-282 moved contacts, notes, media and the rest — every table declared `deviceOwned`
 * carries a `phone_id` that points here. `citizenid` on this row, as on every one of those,
 * is **whoever holds the phone now**, and it moves with the phone: see `handOver`.
 *
 * **`claimed` is what makes the upgrade work without minting into items.** A phone id lives
 * in inventory item metadata and can only be written there at runtime, when a player holds
 * the item — SQL cannot do it. So `0002_phone_data_follows_the_phone` mints one *unclaimed*
 * phone per citizen who had rows and re-keys those rows onto it, and the first item a citizen
 * uses with no id of its own **adopts** that phone rather than minting a fresh one, so the
 * data they had lands on the item in their hand. A server whose inventory cannot carry an id
 * at all — an ungated qb server, standalone, es_extended's own inventory — keeps the
 * unclaimed phone as the citizen's *identity phone* for good: one phone per citizen, which is
 * exactly what they had before.
 *
 * **A tablet is a row here too** (MICA-264), told apart by `kind`. It has an identity of its
 * own — notes, settings and a lock screen of its own, keyed on its own id — but none of a
 * phone's reach: every lookup that means "the citizen's phone" (`phoneForCitizen`,
 * `identityPhone`, adoption) reads `kind = 'phone'` only, so an offline call log or a
 * notification never lands on a tablet, and a tablet never gets a number. The `phone_id`
 * column and the `phoneId` item-metadata key keep their names for both: renaming either is
 * churn across every device-owned table for no change in meaning.
 *
 * **Nothing here is reachable from a client.** Every generic action is off, so this
 * declaration registers no net event at all — a phone id is minted by the server and is never
 * something a payload sets, chooses or deletes (§2.9).
 */
export interface PhoneRow {
  id: number;
  citizenid: string;
  phone_id: string;
  /** Which device this is (MICA-264). Fixed when the row is minted; nothing changes it. */
  kind: DeviceId;
  /** Bound to an inventory item, or still waiting for the first item its citizen uses. */
  claimed: number | boolean;
  status: string;
  updated_at?: Date | string;
}

export const phones = defineService<PhoneRow>({
  id: 'phones',
  table: 'mica_phones',
  access: { read: 'owner', write: 'server' },
  schema: {
    /**
     * 32 hex characters from `randomBytes(16)`.
     *
     * Opaque rather than the row's own `id`, because this string is written into item
     * metadata, where a player with a modified inventory can read it and any resource sharing
     * the inventory can see it. A sequential integer there would let somebody enumerate every
     * phone on the server by counting. It is **not** a secret and nothing treats it as one —
     * MICA-281 makes a phone id useless without the citizen predicate beside it — but there is
     * no reason to hand out a guessable one.
     */
    phone_id: { type: 'string', length: 32, notNull: true, clientWritable: false },
    /**
     * Which device this row is (MICA-264): one value per entry in `shared/devices.ts`.
     *
     * Defaulted to `'phone'`, which is what makes this additive with no backfill: every row
     * that existed before the tablet had an identity is a phone. `micaschema apply`'s additive
     * half adds it to a live table. No index of its own: every read that filters on it also
     * names the citizen, whose `citizenid_status` key narrows to a handful of rows first.
     */
    kind: {
      type: 'enum',
      values: ALL_DEVICES,
      notNull: true,
      default: DEFAULT_DEVICE,
      clientWritable: false
    },
    /**
     * `0` until the phone is written into an inventory item; `1` from then on. A `tinyint`
     * rather than a nullable timestamp because MariaDB's implicit `NOT NULL` on `timestamp`
     * makes `DEFAULT NULL` a per-server question, and this needs one answer.
     */
    claimed: { type: 'bool', notNull: true, default: 0, clientWritable: false }
  },
  indexes: [
    // Uniqueness is the schema's job. Two phones sharing an id would be two players sharing a
    // phone now that MICA-282 keys rows on it.
    // Not unique on citizenid, deliberately: the whole point of MICA-219 is that a character
    // may hold several phones. `defineService` already emits a `citizenid_status` key, and a
    // lookup by citizenid alone uses its leading column, so no separate one is declared here.
    { name: 'phone_id_unique', columns: ['phone_id'], unique: true }
  ],
  uniqueAfterDelete: {
    optOut:
      'A phone id is minted once and nothing retires one; a create that loses the race to a ' +
      'concurrent one is refused by the key on purpose, and the next resolve reads the winner.'
  },
  options: {
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  }
});

const repo = phones.repo;

/** What a minted id looks like, and the only shape trusted off item metadata. */
const PHONE_ID = /^[0-9a-f]{32}$/;

const newPhoneId = (): string => randomBytes(16).toString('hex');

/** One map per device kind (MICA-264): a phone and a tablet are two answers, never one. */
const byKind = <K, V>(): Record<DeviceId, Map<K, V>> =>
  Object.fromEntries(ALL_DEVICES.map((kind) => [kind, new Map<K, V>()])) as Record<
    DeviceId,
    Map<K, V>
  >;

/** Who this process last confirmed holds each phone, so the hot path is not a query. */
const holderOf = new Map<string, string>();
/**
 * Which kind each phone id is, once read or minted (MICA-264). A row's kind never changes, so
 * this is never invalidated: it only saves the query that refuses a phone id carried on a
 * tablet item, or the reverse.
 */
const kindOf = new Map<string, DeviceId>();
/** The device of each kind each citizen most recently resolved to, for rows written on their behalf. */
const activeByCitizen = byKind<string, string>();
/**
 * The device of each kind each connected source most recently resolved to (MICA-283), for the
 * two callers that need the answer **synchronously**: `LockState` keys the external lock on
 * it, and the battery's tick loop asks which phone a live charge belongs to. Keyed by source,
 * so cleared on `playerDropped` — FiveM reuses server ids, and a stale entry would key the
 * next player's lock and charge to a device they have never held.
 *
 * Each entry names the citizen it was resolved for (MICA-264), so a resolve that cannot answer
 * — no item gate, no character — can still tell an entry left by the character before a
 * switch on the same source, and drop it. `forgetActive` has the rules.
 */
const activeBySource = byKind<number, { phoneId: string; citizenid: string }>();
/** Each citizen's identity device of each kind, once found or minted. */
const identityByCitizen = byKind<string, string>();

/**
 * Whoever needs to move rows that `transferPhoneRows` cannot reach when a phone changes hands.
 *
 * Every table with a `phone_id` column is walked automatically through
 * `phoneKeyedRepositories`; this is for the one shape that list cannot hold — a child table
 * with no repository of its own, which is `mica_messages_participants`. `Conversations.ts`
 * registers it.
 *
 * **A hook must be idempotent** (MICA-319). One that throws is run again on a later request
 * for as long as it keeps failing, and a hook that succeeded is run again whenever a later
 * walk is a full one — after another hook or table failed and the phone changed hands again,
 * or after a restart. A `WHERE … AND citizenid <> ?` update, like the participants transfer,
 * is the shape: a second run finds nothing left to move.
 */
type HandoverRun = (phoneId: string, citizenid: string) => Promise<unknown> | unknown;
const handoverHooks: { name: string; run: HandoverRun }[] = [];

export const onPhoneHandover = (name: string, run: HandoverRun): void => {
  handoverHooks.push({ name, run });
};

/**
 * Whoever sets a phone up the first time it exists (MICA-234) — `Contacts.ts`, which seeds the
 * owner's default contacts. A hook is handed the new row's `kind` (MICA-264) and decides for
 * itself what a tablet gets; the default contacts are a phone's, so a tablet gets none. Registered here rather than imported, for the reason the handover
 * hooks are: this file must not import the services that key on it.
 *
 * "New" means this server just inserted the phone's `mica_phones` row, which happens once per
 * phone id (`phone_id_unique`) and never again: nothing deletes a phone row, a handover and a
 * claim update the one that exists, and the rows `0002_phone_data_follows_the_phone` backfilled
 * were inserted by SQL, not here, so an existing player's phone is never treated as new. That
 * once-only insert is the mark — a player who deletes a seeded contact is never re-seeded,
 * because nothing re-creates the phone.
 *
 * Hooks run **after** the phone is answered, not inside the request that created it: a new
 * phone's first request should not wait on an owner's contact list. So a hook's work may land
 * a moment after the phone does, and nothing may depend on it having finished.
 *
 * **A hook that throws is run again** (MICA-327), on a later resolve of the same phone, until
 * it succeeds — so it must be idempotent: a second run finishes what the first left and adds
 * nothing the first already wrote. The phone row cannot be the mark that a hook *finished*,
 * only that the phone is new, because it is inserted before any hook runs. Every run is handed
 * whoever holds the phone when it runs, which after a handover is not who it was created for,
 * so rows land with the holder the handover walk already moved the rest to.
 *
 * **A hook must never await `resolvePhone`, `phoneForRequest`, `activePhone` or anything else
 * that reaches `ensureHeld` for the same phone.** Hooks run on the phone's queue
 * (`queueOnPhone`), and a resolve that has to settle a holder joins that queue behind the hook
 * awaiting it — neither ever finishes, and every later uncached resolve of the phone waits
 * behind both. A hook is handed the phone id and the holder for exactly that reason.
 */
type CreatedRun = (
  phoneId: string,
  citizenid: string,
  kind: DeviceId
) => Promise<unknown> | unknown;
type CreatedHook = { name: string; run: CreatedRun };
const createdHooks: CreatedHook[] = [];

export const onPhoneCreated = (name: string, run: CreatedRun): void => {
  createdHooks.push({ name, run });
};

/**
 * New-phone hooks that threw, by phone, and when to try them again (MICA-327). Process memory:
 * a restart before the retry lands forgets it — the schema has nowhere durable to say "set-up
 * unfinished" without a column, which this does not add.
 */
interface OwedSetup {
  hooks: readonly CreatedHook[];
  /** The kind the row was minted as, handed to every retry as it was to the first run. */
  kind: DeviceId;
  failures: number;
  /** No retry before this; `Infinity` while one is already queued. */
  retryAt: number;
}
const owedSetup = new Map<string, OwedSetup>();

/**
 * Who holds the phone now, as far as this process knows: a handover still owed names its new
 * holder, else the last one settled, else `fallback` — the citizen the caller resolved for,
 * which on the identity path, where `holderOf` is never written, is the only answer.
 */
const holderNow = (phoneId: string, fallback: string): string =>
  pendingHandover.get(phoneId)?.citizenid ?? holderOf.get(phoneId) ?? fallback;

/**
 * Run these hooks for this phone, each its own failure, and remember any that threw. Never
 * rejects. Only ever run from the phone's queue (`queueOnPhone`), so it cannot overlap
 * another run for the phone — which is what keeps an idempotent hook from doubling — or a
 * handover: a seed that wrote rows naming the old holder after the new holder's walk had
 * moved the rest would leave them there, since that holder is cached with nothing to walk.
 * The rows go to whoever holds the phone **when it runs**, for the same reason.
 */
const runCreated = async (
  phoneId: string,
  fallback: string,
  kind: DeviceId,
  hooks: readonly CreatedHook[],
  owed: OwedSetup | undefined
): Promise<void> => {
  const citizenid = holderNow(phoneId, fallback);
  const failures = (owed?.failures ?? 0) + 1;
  const wait = retryDelay(failures);
  const when =
    wait === 0
      ? "on the phone's next resolve"
      : `no sooner than ${wait / 1000}s from now, on the phone's next resolve`;
  const failed: CreatedHook[] = [];
  for (const hook of hooks) {
    try {
      await hook.run(phoneId, citizenid, kind);
    } catch (error) {
      failed.push(hook);
      console.error(
        `[mica] new-phone hook '${hook.name}' failed for phone ${phoneId} ` +
          `(attempt ${failures}); retrying ${when}.`,
        error
      );
    }
  }
  if (failed.length === 0) {
    owedSetup.delete(phoneId);
  } else {
    owedSetup.set(phoneId, { hooks: failed, kind, failures, retryAt: Date.now() + wait });
  }
};

/** The phone row was just inserted: queue every hook behind whatever the phone is doing. */
const announceCreated = (phoneId: string, citizenid: string, kind: DeviceId): void => {
  kindOf.set(phoneId, kind);
  void queueOnPhone(phoneId, () => runCreated(phoneId, citizenid, kind, createdHooks, undefined));
};

/**
 * Retry whatever a new phone's hooks left, if anything, without holding up the resolve that
 * calls it: queued, not awaited, so the **next** call for the phone waits behind it instead.
 * One map lookup when nothing is owed, which is every phone but a failed new one; backed off
 * like a handover retry, so a hook that keeps failing is one attempt per wait.
 */
const finishSetup = (phoneId: string, citizenid: string): void => {
  const owed = owedSetup.get(phoneId);
  if (!owed || Date.now() < owed.retryAt) return;
  owed.retryAt = Number.POSITIVE_INFINITY;
  void queueOnPhone(phoneId, () => {
    const current = owedSetup.get(phoneId);
    return current
      ? runCreated(phoneId, citizenid, current.kind, current.hooks, current)
      : undefined;
  });
};

/** One table the handover walks, or one hook it runs. */
type PhoneKeyedRepository = (typeof phoneKeyedRepositories)[number];
type HandoverHook = (typeof handoverHooks)[number];

/**
 * The part of a handover still to do: the tables and hooks that have not moved yet. `tables`
 * names `mica_phones` itself whenever anything else is left, because that row moves last.
 */
interface HandoverWork {
  tables: readonly PhoneKeyedRepository[];
  hooks: readonly HandoverHook[];
}

/**
 * A handover that did not finish (MICA-319): the phone is this citizen's, but these tables and
 * hooks still name the previous holder.
 *
 * Kept apart from `holderOf` because the two answer different questions. `holderOf` is "nothing
 * left to do for this holder", and caching a partial handover there meant the tables that
 * failed were never retried for as long as the player held the phone. Keyed by phone, so a
 * second handover to somebody else replaces it — that one is a full walk, which moves the
 * tables this entry was owed anyway.
 *
 * This is the in-process half, which keeps a retry narrow and backed off. The durable half is
 * the `mica_phones` row: `handOver` moves it only once everything else has, so a restart that
 * drops this map still finds a row naming the previous holder, and the first resolve after it
 * walks every table again.
 */
interface PendingHandover extends HandoverWork {
  citizenid: string;
  /** Attempts in a row that left something behind, the first handover included. */
  failures: number;
  /** No retry before this `Date.now()`, so a table that keeps failing costs one try per wait. */
  retryAt: number;
}
const pendingHandover = new Map<string, PendingHandover>();

/**
 * How long to wait before retrying, by how many attempts in a row have failed. The first retry
 * is the next request — most failures are a dropped connection or a lock wait, gone a moment
 * later — and a table that keeps failing settles at one attempt, and one log line, every ten
 * minutes rather than one per request.
 */
const RETRY_AFTER_MS = [0, 5_000, 30_000, 120_000, 600_000];
const retryDelay = (failures: number): number =>
  RETRY_AFTER_MS[Math.min(failures, RETRY_AFTER_MS.length) - 1];

/**
 * The work queued for each phone — `ensureHeld`, and since MICA-327 the new-phone hooks — which
 * the next call for that phone waits behind (MICA-319). Two requests for one phone otherwise both read `pendingHandover`, both walk, and
 * the slower one records what the faster one already settled. An entry is deleted when the
 * last call chained onto it settles, so this holds only phones with a call in flight.
 */
const settling = new Map<string, Promise<void>>();

/**
 * Run `work` for this phone once everything already queued for it has settled, and answer
 * when it has. The queue is `ensureHeld` and the new-phone hooks (MICA-327): both write rows
 * that name a holder, so neither may run under the other.
 */
const queueOnPhone = (phoneId: string, work: () => Promise<void> | void): Promise<void> => {
  const run = async (): Promise<void> => {
    await work();
  };
  const next = (settling.get(phoneId) ?? Promise.resolve()).then(run, run);
  settling.set(phoneId, next);
  const forget = (): void => {
    if (settling.get(phoneId) === next) settling.delete(phoneId);
  };
  void next.then(forget, forget);
  return next;
};

/** Test seam: module state that would otherwise leak between cases. Hooks are registrations and stay. */
export const __resetPhoneState = (): void => {
  holderOf.clear();
  kindOf.clear();
  pendingHandover.clear();
  settling.clear();
  owedSetup.clear();
  for (const kind of ALL_DEVICES) {
    activeByCitizen[kind].clear();
    activeBySource[kind].clear();
    identityByCitizen[kind].clear();
  }
};

/**
 * The phone a connected source last resolved to, or null before its first resolve.
 *
 * Synchronous by design and therefore a cache, not a lookup: it answers what the last
 * `resolvePhone`/`phoneForRequest` for this source found. Every device-owned request
 * refreshes it, and so does the sync `deviceItem.ts` fires on load, use and inventory change,
 * so it is stale for at most the gap between using a phone and the server hearing about it.
 */
export const activePhoneIdOf = (src: number): string | null =>
  activeBySource.phone.get(src)?.phoneId ?? null;

/**
 * `activePhoneIdOf` for any device kind (MICA-264): the device of that kind a connected source
 * last resolved to, or null. `LockState` keys a tablet's external lock on it.
 */
export const activeDeviceIdOf = (src: number, kind: DeviceId): string | null =>
  activeBySource[kind].get(src)?.phoneId ?? null;

on('playerDropped', () => {
  for (const kind of ALL_DEVICES) activeBySource[kind].delete(source);
});

/** The phone a player is currently on. */
export interface ActivePhone {
  phoneId: string;
  slot: number;
}

/**
 * The phone changed hands: every row on it now belongs to whoever is holding it (MICA-282).
 *
 * This is what makes a stolen phone show its data to the thief, and it is deliberately a
 * *transfer* rather than a weaker predicate. §2.9's rule — every read and write names the
 * citizen and the phone — is untouched; what moves is which citizen the rows name. The
 * authorization is the inventory's own export having just said this player holds the item
 * carrying this id, which is the same trust the framework itself is given.
 *
 * Each table is its own statement and its own failure: a table that could not be moved is
 * logged and the rest still move, because half a handover with a line saying which half is
 * better than a phone that stays the victim's in every table because one of them errored.
 *
 * **`mica_phones` moves last, and only when every other table and hook has** (MICA-319). Its
 * row is what `ensureHeld` reads after a restart, when `pendingHandover` is gone: a row still
 * naming the previous holder is the durable mark that this handover is not finished, and the
 * first resolve walks every table again. Moving it first, as the declaration order used to,
 * left a restart reading a finished handover over tables that never moved.
 *
 * Answers what is left to do, which `ensureHeld` keeps and retries. `work` narrows a retry to
 * exactly that; every statement is `citizenid <> ?`-guarded as well, so re-running one that
 * already moved its rows finds nothing to move.
 */
const handOver = async (
  phoneId: string,
  citizenid: string,
  work: HandoverWork = { tables: phoneKeyedRepositories, hooks: handoverHooks }
): Promise<HandoverWork> => {
  const tables: PhoneKeyedRepository[] = [];
  const hooks: HandoverHook[] = [];
  // Most walks move nothing — the first resolve after a start re-checks a phone whose rows all
  // name its holder already — so only one that moved a row says so.
  let moved = false;
  for (const keyed of work.tables) {
    if (keyed === repo) continue;
    try {
      if (await keyed.transferPhoneRows(phoneId, citizenid)) moved = true;
    } catch (error) {
      tables.push(keyed);
      console.error(
        `[mica] could not move ${keyed.table} on phone ${phoneId} to ${citizenid}.`,
        error
      );
    }
  }
  for (const hook of work.hooks) {
    try {
      if ((await hook.run(phoneId, citizenid)) === true) moved = true;
    } catch (error) {
      hooks.push(hook);
      console.error(`[mica] handover hook '${hook.name}' failed for phone ${phoneId}.`, error);
    }
  }
  if (work.tables.includes(repo)) {
    if (tables.length > 0 || hooks.length > 0) {
      tables.push(repo);
    } else {
      try {
        if (await repo.transferPhoneRows(phoneId, citizenid)) moved = true;
      } catch (error) {
        tables.push(repo);
        console.error(
          `[mica] could not move ${repo.table} on phone ${phoneId} to ${citizenid}.`,
          error
        );
      }
    }
  }
  if (tables.length === 0 && hooks.length === 0) {
    if (moved) {
      console.log(`[mica] phone ${phoneId} is now held by ${citizenid}; its rows moved with it.`);
    }
  } else {
    const stuck = [
      ...tables.map((keyed) => keyed.table),
      ...hooks.map((hook) => `hook '${hook.name}'`)
    ];
    console.error(
      `[mica] phone ${phoneId} is held by ${citizenid}, but ${stuck.join(', ')} still name ` +
        `its previous holder; a later request retries them, and ${repo.table} moves last.`
    );
  }
  return { tables, hooks };
};

/**
 * Remember what a handover left behind, or that it left nothing — unless the entry this call
 * started from has been replaced meanwhile, in which case its answer is stale and the newer
 * entry stands. `started` is the entry read before the walk, whoever it was owed to; it is
 * the owed one whenever this was a retry. Answers whether it recorded, so a stale call leaves
 * `holderOf` to whoever replaced it as well.
 */
const recordHandover = (
  phoneId: string,
  citizenid: string,
  left: HandoverWork,
  started: PendingHandover | undefined
): boolean => {
  if (pendingHandover.get(phoneId) !== started) return false;
  if (left.tables.length === 0 && left.hooks.length === 0) {
    pendingHandover.delete(phoneId);
    return true;
  }
  const failures = (started?.citizenid === citizenid ? started.failures : 0) + 1;
  pendingHandover.set(phoneId, {
    citizenid,
    tables: left.tables,
    hooks: left.hooks,
    failures,
    retryAt: Date.now() + retryDelay(failures)
  });
  return true;
};

/**
 * Make sure the phone has a row naming this holder, without paying a query on every resolve.
 *
 * Keyed on `phone_id` rather than the row id, because the id in item metadata is all a caller
 * has. Three outcomes: no row yet, so one is created already claimed (the id is on an item);
 * a row naming somebody else, which is a handover; a row still unclaimed, which this claims.
 * A create that loses a race with a concurrent one violates `phone_id_unique`, which is the
 * correct outcome — the row exists either way, and the next resolve reads it.
 *
 * **Calls for one phone run one after another** (`settling`), so each reads what the one
 * before it recorded rather than racing it.
 *
 * **A handover that left a table behind is not cached as done** (MICA-319). What it left is
 * kept in `pendingHandover` and retried, alone, on a later request — backed off, so a table
 * that keeps failing costs one attempt per wait rather than one per request. The phone answers
 * either way: a table still naming the previous holder hides those rows from this one until a
 * retry lands, which is better than refusing the phone over them. Which walk runs:
 *
 * - A handover to this citizen is owed: the tables and hooks it left, and nothing else. The
 *   `mica_phones` row still names the previous holder then, by design (`handOver`).
 * - Anything else that gets past the cache: a full walk. Every statement moves whatever does
 *   not name this citizen yet, so it also finishes what any earlier handover left.
 *
 * **"Anything else" includes a phone whose row already names this citizen**, on purpose: the
 * first resolve of each phone after a start walks it even when the row says nothing moved.
 * The row marks a handover *to* its holder as unfinished (`handOver` moves it last), but not
 * one that was going the other way when the server stopped — a thief's handover that moved
 * some tables and left the row with the owner, who then has the phone back after the restart.
 * The row names the owner and the moved tables name the thief, and only a walk finds them.
 *
 * That costs one indexed `UPDATE` per phone-keyed table and one per handover hook, matching
 * no row in the usual case, **once per phone per process**: a walk that finishes is cached in
 * `holderOf` and nothing walks that phone again until it changes hands, which walks anyway.
 */
const ensureHeld = async (
  phoneId: string,
  citizenid: string,
  kind: DeviceId
): Promise<DeviceId | null> => {
  // A row of another kind is refused before anything is written or walked (MICA-264): a phone
  // id copied onto a tablet item must not hand the phone's rows to whoever holds the tablet.
  const known = kindOf.get(phoneId);
  if (known !== undefined && known !== kind) return known;
  // The hot path, answered without joining the queue: this holder is settled and nothing is
  // owed. Queuing it would make every resolve of a new phone wait behind its seed, which can be
  // minutes of lock waits (MICA-327). A read only — anything that could need writing (a new
  // holder, a handover still owed, a first resolve) misses here and queues as before. A
  // settled holder means the row was read, so `known` is its kind here.
  if (!pendingHandover.has(phoneId) && holderOf.get(phoneId) === citizenid) {
    return known ?? kind;
  }
  let heldAs: DeviceId | null = null;
  await queueOnPhone(phoneId, async () => {
    heldAs = await settleHolder(phoneId, citizenid, kind);
  });
  return heldAs;
};

/**
 * Settle the holder, and answer which kind the row is (MICA-264): `kind` when the row is the
 * caller's kind or was just created as it, the row's own kind when that differs — in which case
 * nothing is written, walked or claimed — and `null` when the row could not be read, so nobody
 * can say. The one read of the row per phone per process is also the kind check, which is why
 * the check lives here rather than in a query of its own before it.
 */
const settleHolder = async (
  phoneId: string,
  citizenid: string,
  kind: DeviceId
): Promise<DeviceId | null> => {
  const known = kindOf.get(phoneId);
  if (known !== undefined && known !== kind) return known;
  const pending = pendingHandover.get(phoneId);
  const owed = pending?.citizenid === citizenid ? pending : undefined;
  if (owed ? Date.now() < owed.retryAt : holderOf.get(phoneId) === citizenid) {
    return known ?? kind;
  }

  let read = false;
  try {
    const [existing] = await repo.findAll({ phone_id: phoneId } as Partial<PhoneRow>);
    read = true;
    if (existing) {
      const recorded = isDeviceId(existing.kind) ? existing.kind : DEFAULT_DEVICE;
      kindOf.set(phoneId, recorded);
      if (recorded !== kind) return recorded;
    }
    if (!existing) {
      await repo.create({ citizenid, phone_id: phoneId, kind, claimed: 1 } as Partial<PhoneRow>);
      announceCreated(phoneId, citizenid, kind);
    }
    let done = true;
    let stale = false;
    if (existing) {
      // What this citizen is owed, or — past the cache with nothing owed to them: the first
      // resolve since a start, a phone that changed hands, a handover to somebody else still
      // owed — a full walk. Recorded before the claim below, so a claim that throws cannot lose
      // what this walk left.
      const left = await handOver(phoneId, citizenid, owed);
      done = left.tables.length === 0 && left.hooks.length === 0;
      stale = !recordHandover(phoneId, citizenid, left, pending);
    }
    if (existing && !Number(existing.claimed)) {
      await repo.update(existing.id, { claimed: 1 } as Partial<PhoneRow>, citizenid);
    }
    if (!stale) {
      if (done && !pendingHandover.has(phoneId)) holderOf.set(phoneId, citizenid);
      else holderOf.delete(phoneId);
    }
    identityByCitizen[kind].delete(citizenid);
    return kind;
  } catch (error) {
    // Not fatal and not cached: the id is on the item either way, so the next resolve retries.
    console.error(`[mica] could not record the phone row for ${phoneId}`, error);
    // Read and of this kind, or read and absent: still the caller's kind. Not read at all:
    // nobody can say, and the caller decides what that costs.
    return kindOf.get(phoneId) ?? (read ? kind : null);
  }
};

/**
 * The citizen's device of this kind that is bound to no item yet, or null. Lowest id when there
 * are several. By kind (MICA-264), so a phone item never adopts a tablet's identity row.
 */
const readUnclaimed = async (citizenid: string, kind: DeviceId): Promise<PhoneRow | null> => {
  const rows = await repo.findAll({ citizenid, kind, claimed: 0 } as Partial<PhoneRow>);
  if (rows.length === 0) return null;
  return rows.reduce((lowest, row) => (row.id < lowest.id ? row : lowest));
};

/**
 * The phone a citizen is on when no item can say (MICA-282).
 *
 * One phone per citizen, minted server-side and never written into an item — the shape every
 * server had before phones were items, kept for the servers that still cannot carry one: an
 * ungated qb server, standalone, es_extended's own inventory. On a gated server it is also
 * the phone the first item a citizen uses adopts, which is how the migration's backfill lands
 * on a real item; `resolvePhone` clears the cache below when that happens.
 *
 * **A tablet has one too** (MICA-264), for the same servers: one per citizen, `kind = 'tablet'`,
 * minted the first time a tablet request finds no tablet item that can carry an id. Nothing
 * adopts it — a tablet item always mints its own — so it stays the identity for good there.
 */
const identityDevice = async (citizenid: string, kind: DeviceId): Promise<string> => {
  const known = identityByCitizen[kind].get(citizenid);
  if (known) {
    finishSetup(known, citizenid);
    return known;
  }

  const unclaimed = await readUnclaimed(citizenid, kind);
  let phoneId: string;
  if (unclaimed) {
    phoneId = unclaimed.phone_id;
    kindOf.set(phoneId, kind);
    finishSetup(phoneId, citizenid);
  } else {
    phoneId = newPhoneId();
    await repo.create({ citizenid, phone_id: phoneId, kind, claimed: 0 } as Partial<PhoneRow>);
    announceCreated(phoneId, citizenid, kind);
  }
  identityByCitizen[kind].set(citizenid, phoneId);
  return phoneId;
};

/** The citizen's identity phone — `identityDevice` for the phone, never a tablet. */
export const identityPhone = (citizenid: string): Promise<string> =>
  identityDevice(citizenid, 'phone');

/**
 * The phone a citizen is on, for a row written on their behalf — a notification, a photo
 * dropped onto them, a contact a job hands them, a call logged against them. Always a phone,
 * never a tablet (MICA-264).
 *
 * Their active phone when this process has resolved one; else the phone they touched most
 * recently, which a handover and a claim both move `updated_at` for; else their identity
 * phone, created if they have none at all. The middle case is an offline player on a gated
 * server: nothing is in hand to ask, and the phone they last used is the best answer there is.
 *
 * **The cached phone is only an answer while nobody else is known to hold it** (MICA-339).
 * `activeByCitizen` is written by every resolve and cleared by none, so after a robbery it
 * still names the phone the thief now holds. Rows filed there under the victim are hidden from
 * the victim and handed to the thief by the next handover walk. Checked against `holderNow`
 * rather than cleared at the handover, so the one record of who holds a phone decides, and a
 * cache entry can never outlive it.
 */
export const phoneForCitizen = async (citizenid: string): Promise<string> => {
  const active = activeByCitizen.phone.get(citizenid);
  if (active) {
    if (holderNow(active, citizenid) === citizenid) return active;
    activeByCitizen.phone.delete(citizenid);
  }

  // Phones only (MICA-264): a call logged against an offline player, or a notification for
  // one, must never land on the tablet they happened to touch last.
  const latest = await Database.single<{ phone_id: string } | null>(
    `SELECT \`phone_id\` FROM \`mica_phones\`
     WHERE \`citizenid\` = ? AND \`kind\` = 'phone' AND \`status\` = 'active'
     ORDER BY \`updated_at\` DESC, \`id\` DESC LIMIT 1`,
    [citizenid]
  );
  if (latest?.phone_id) return latest.phone_id;

  return await identityPhone(citizenid);
};

/**
 * What resolving a source's phone can come to, and why three answers rather than a nullable.
 *
 * MICA-280 folded every non-answer into `null`, and for its one caller that was right. The
 * number sync (MICA-284) and the request resolver (MICA-282) have to tell two of them apart: a
 * player on a gated server who holds **no** phone must be refused — they have no phone for
 * rows to belong to, and the phone is closed for them anyway — while a server that cannot
 * carry a phone id at all degrades to the citizen's identity phone. The other causes of
 * `'unavailable'` (no gate configured, no loaded character, the metadata write failed) all
 * want that same degrade.
 */
export type PhoneResolution =
  | { status: 'active'; phone: ActivePhone }
  /** A phone item is required here and this player holds none. */
  | { status: 'none' }
  /** No phone identity can be had on this server, or for this source, right now. */
  | { status: 'unavailable' };

const UNAVAILABLE: PhoneResolution = { status: 'unavailable' };
const NONE: PhoneResolution = { status: 'none' };

/** Record a device as the one this source and its citizen are on now. */
const markActive = (src: number, citizenid: string, kind: DeviceId, phoneId: string): void => {
  activeByCitizen[kind].set(citizenid, phoneId);
  activeBySource[kind].set(src, { phoneId, citizenid });
};

/**
 * Drop the device of this kind a source was last on, when a resolve finds it is no longer
 * theirs (MICA-264) — unless it was resolved for `keep`, the character the source has now.
 *
 * A resolve that answers `'none'` passes no `keep`: they hold none, so whatever was cached is
 * somebody else's now, or nobody's, and `LockPhone` must not key it. One that answers
 * `'unavailable'` passes the current character: on a server that cannot carry an id that
 * answer is the steady state, and the identity device `phoneForRequest` cached for this same
 * character is still right, but one cached for the previous character after a switch is not.
 */
const forgetActive = (src: number, kind: DeviceId, keep?: string): void => {
  const entry = activeBySource[kind].get(src);
  if (entry && entry.citizenid !== keep) activeBySource[kind].delete(src);
};

/**
 * The device of this kind this source is using, minting one into the item the first time.
 *
 * **The rule lives here and nowhere else**, so no service re-implements it: the device in the
 * slot this player last *used*, falling back to the lowest slot they hold. Last-used rather
 * than purely positional because a player switches phones by using one, which is visible,
 * where switching by dragging items between slots is not. `readItemSlots` returns slots
 * ascending precisely so the fallback is `slots[0]` rather than a sort somebody has to repeat.
 * Each kind has its own item, its own last-used slot and its own rows (MICA-264).
 *
 * **A carried id must name a row of the same kind** (MICA-264), or it is refused and the item
 * is given a fresh one, as an item with no id is. `ensureHeld` answers the kind from the one
 * read of the row it already makes, and writes nothing for a row of another kind. Both items
 * carry the id under the same `phoneId` key, so without this a phone id copied onto a tablet
 * item — by an admin menu, a crafting script, a modified inventory — would open the phone's
 * notes and passcode on the tablet, and the reverse.
 *
 * **A resolve that finds no device of this kind clears the cached one** (`forgetActive`), so
 * the synchronous answer `LockState` keys on never outlives the item it named.
 *
 * **A phone item with no id adopts the citizen's unclaimed phone before minting.** That is the
 * runtime half of the migration's backfill: the rows it re-keyed are on that phone, and the
 * first item in the player's hand is the one they should land on. Only when there is none is
 * a fresh id minted. **A tablet never adopts**: there was no tablet data before MICA-264 for a
 * backfill to have put anywhere, so a tablet item always mints its own.
 *
 * **A minted id is written to the item before it is recorded**, and the resolve answers
 * `'unavailable'` if that write fails. The other order is worse: a row created for an id that
 * never reached the item is an orphan nothing will ever point at, where an id on an item with
 * no row yet is simply picked up and recorded by the next resolve.
 */
export const resolveDevice = async (src: number, kind: DeviceId): Promise<PhoneResolution> => {
  // An off device has no item to hold. `ServiceEndpoint` refuses its requests before this.
  if (!isDeviceEnabled(kind)) {
    forgetActive(src, kind);
    return NONE;
  }
  const player = FrameworkBridge.getPlayer(src);
  const unavailable = (): PhoneResolution => {
    forgetActive(src, kind, player?.citizenid);
    return UNAVAILABLE;
  };

  const item = deviceItemName(kind);
  if (!item) return unavailable();
  if (!player?.citizenid) return unavailable();

  const slots = FrameworkBridge.itemSlots(player, item);
  // `null` is "this inventory cannot say", never "holds none" — treating them alike would mint
  // a fresh phone on every resolve for a server that can never store one.
  if (slots === null) return unavailable();
  if (slots.length === 0) {
    forgetActive(src, kind);
    return NONE;
  }

  const preferred = lastUsedDeviceSlot(src, kind);
  const chosen = slots.find((entry) => entry.slot === preferred) ?? slots[0];

  const carried = chosen.metadata.phoneId;
  if (typeof carried === 'string' && PHONE_ID.test(carried)) {
    const carriedKind = await ensureHeld(carried, player.citizenid, kind);
    if (carriedKind === kind) {
      finishSetup(carried, player.citizenid);
      markActive(src, player.citizenid, kind, carried);
      return { status: 'active', phone: { phoneId: carried, slot: chosen.slot } };
    }
    if (carriedKind === null) {
      // Which device this id is could not be read. Using it might be a phone id on a tablet;
      // minting over it might be overwriting a real device's id. Neither, until a read works.
      throw new Error(`[mica] could not read which device ${carried} is; refusing the resolve.`);
    }
    console.warn(
      `[mica] ${player.citizenid}'s ${kind} item in slot ${chosen.slot} carried ${carried}, ` +
        `which is a ${carriedKind}. Refused; the item is given a ${kind} id of its own.`
    );
  }

  let adopted: string | null = null;
  if (kind === 'phone') {
    try {
      adopted = (await readUnclaimed(player.citizenid, kind))?.phone_id ?? null;
    } catch (error) {
      // A fresh id is the safe answer: nothing is lost, the unclaimed phone stays where it is.
      console.error(`[mica] could not look for ${player.citizenid}'s unclaimed phone`, error);
    }
  }
  const phoneId = adopted ?? newPhoneId();

  if (!FrameworkBridge.setItemMetadata(player, item, chosen.slot, { phoneId })) {
    // `writeItemMetadata` has already said why, once. Claiming an id the item does not carry
    // would hand this player a different phone on their next relog.
    return unavailable();
  }

  // Its kind is this one by construction — a fresh id has no row, and an adopted one was read
  // by kind — so what `ensureHeld` answers is not asked.
  await ensureHeld(phoneId, player.citizenid, kind);
  finishSetup(phoneId, player.citizenid);
  markActive(src, player.citizenid, kind, phoneId);
  return { status: 'active', phone: { phoneId, slot: chosen.slot } };
};

/**
 * The phone this source is using: `resolveDevice` for the phone. Kept as its own name because
 * the number sync (`PhoneNumbers.ts`) and `GetPhoneNumber` are the phone's alone, and a tablet
 * must never reach either.
 */
export const resolvePhone = (src: number): Promise<PhoneResolution> => resolveDevice(src, 'phone');

/**
 * The phone this source is using, or `null` when they have no phone identity right now.
 *
 * `resolvePhone` with its three answers folded to one, for a caller that does not need to
 * tell "holds none" from "cannot say".
 */
export const activePhone = async (src: number): Promise<ActivePhone | null> => {
  const resolution = await resolvePhone(src);
  return resolution.status === 'active' ? resolution.phone : null;
};

/** What a player who holds none of a device is told. The phone keeps its own MICA-282 key. */
const notHeld = (device: DeviceId): PlayerFacingError =>
  device === 'phone'
    ? new PlayerFacingError('You are not holding a phone.', { key: 'server.phone.notHeld' })
    : new PlayerFacingError(`You are not holding a ${DEVICES[device].label.toLowerCase()}.`, {
        key: 'server.device.notHeld',
        params: { device: DEVICES[device].label }
      });

/**
 * The device a request is for — what `ServiceEndpoint` asks before running a device-owned
 * action (MICA-282), for whichever device the request named (MICA-264).
 *
 * Holding none on a gated server is a refusal the player can read, not a fallthrough: they
 * have no device for rows to belong to, and it is closed for them anyway (`deviceItem.ts`), so
 * the only way this is reached is a client that opened it regardless. Everything else that is
 * not an item in hand degrades to the citizen's identity device of that kind.
 */
export const phoneForRequest = async (
  src: number,
  citizenid: string,
  device: DeviceId = DEFAULT_DEVICE
): Promise<string> => {
  const resolution = await resolveDevice(src, device);
  if (resolution.status === 'active') return resolution.phone.phoneId;
  if (resolution.status === 'none') throw notHeld(device);
  const identity = await identityDevice(citizenid, device);
  markActive(src, citizenid, device, identity);
  return identity;
};

/**
 * Refuse a request that names a device this server has off, or one the player holds none of
 * (MICA-264) — for every service, device-owned or not, since a request from the tablet is
 * a claim to be holding one. Counted now, through the same `holdsDevice` the item gate uses,
 * so it fails open exactly where that does: no gate configured, standalone, or an inventory
 * that cannot count.
 */
export const requireDeviceInHand = (player: FrameworkPlayer, device: DeviceId): void => {
  if (!isDeviceEnabled(device)) {
    throw new PlayerFacingError(
      `The ${DEVICES[device].label.toLowerCase()} is turned off on this server.`,
      { key: 'server.device.off', params: { device: DEVICES[device].label } }
    );
  }
  if (!holdsDevice(player, device)) throw notHeld(device);
};

/**
 * Re-resolve a non-phone device whenever `deviceItem.ts` says it may have changed (MICA-264):
 * a load, a relayed inventory change, a use of its item. The phone's own subscribers (the
 * number sync, the battery) already resolve the phone on those occasions, which refreshes or
 * clears its entry the same way; this gives the tablet the same, so `LockPhone(src, 'tablet')`
 * after a switch, a handover or a character switch keys the tablet in hand, not the last one a
 * device-owned request happened to resolve. Nothing is minted for a tablet nobody holds: a
 * resolve that finds none clears the entry and writes nothing.
 */
onDeviceStateChanged('device-identity', (src, device) => resolveDevice(src, device));

installPhoneResolvers({
  forRequest: phoneForRequest,
  forCitizen: phoneForCitizen,
  deviceInHand: requireDeviceInHand
});
