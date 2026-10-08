// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { Database } from '../lib/Database';
import { defineService, phoneKeyedRepositories } from '../lib/defineService';
import { PlayerFacingError } from '../lib/errors';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { installPhoneResolvers } from '../lib/phoneIdentity';
import { lastUsedPhoneSlot, phoneItemName } from '../lib/deviceItem';

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
 * **Nothing here is reachable from a client.** Every generic action is off, so this
 * declaration registers no net event at all — a phone id is minted by the server and is never
 * something a payload sets, chooses or deletes (§2.9).
 */
export interface PhoneRow {
  id: number;
  citizenid: string;
  phone_id: string;
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

/** Who this process last confirmed holds each phone, so the hot path is not a query. */
const holderOf = new Map<string, string>();
/** The phone each citizen most recently resolved to, for rows written on their behalf. */
const activeByCitizen = new Map<string, string>();
/**
 * The phone each connected source most recently resolved to (MICA-283), for the two callers
 * that need the answer **synchronously**: `LockState` keys the external lock on it, and the
 * battery's tick loop asks which phone a live charge belongs to. Keyed by source, so cleared
 * on `playerDropped` — FiveM reuses server ids, and a stale entry would key the next player's
 * lock and charge to a phone they have never held.
 */
const activeBySource = new Map<number, string>();
/** Each citizen's identity phone, once found or minted. */
const identityByCitizen = new Map<string, string>();

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
 * owner's default contacts. Registered here rather than imported, for the reason the handover
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
type CreatedRun = (phoneId: string, citizenid: string) => Promise<unknown> | unknown;
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
      await hook.run(phoneId, citizenid);
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
    owedSetup.set(phoneId, { hooks: failed, failures, retryAt: Date.now() + wait });
  }
};

/** The phone row was just inserted: queue every hook behind whatever the phone is doing. */
const announceCreated = (phoneId: string, citizenid: string): void => {
  void queueOnPhone(phoneId, () => runCreated(phoneId, citizenid, createdHooks, undefined));
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
    return current ? runCreated(phoneId, citizenid, current.hooks, current) : undefined;
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
  pendingHandover.clear();
  settling.clear();
  owedSetup.clear();
  activeByCitizen.clear();
  activeBySource.clear();
  identityByCitizen.clear();
};

/**
 * The phone a connected source last resolved to, or null before its first resolve.
 *
 * Synchronous by design and therefore a cache, not a lookup: it answers what the last
 * `resolvePhone`/`phoneForRequest` for this source found. Every device-owned request
 * refreshes it, and so does the sync `deviceItem.ts` fires on load, use and inventory change,
 * so it is stale for at most the gap between using a phone and the server hearing about it.
 */
export const activePhoneIdOf = (src: number): string | null => activeBySource.get(src) ?? null;

on('playerDropped', () => {
  activeBySource.delete(source);
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
const ensureHeld = (phoneId: string, citizenid: string): Promise<void> => {
  // The hot path, answered without joining the queue: this holder is settled and nothing is
  // owed. Queuing it would make every resolve of a new phone wait behind its seed, which can be
  // minutes of lock waits (MICA-327). A read only — anything that could need writing (a new
  // holder, a handover still owed, a first resolve) misses here and queues as before.
  if (!pendingHandover.has(phoneId) && holderOf.get(phoneId) === citizenid) {
    return Promise.resolve();
  }
  return queueOnPhone(phoneId, () => settleHolder(phoneId, citizenid));
};

const settleHolder = async (phoneId: string, citizenid: string): Promise<void> => {
  const pending = pendingHandover.get(phoneId);
  const owed = pending?.citizenid === citizenid ? pending : undefined;
  if (owed ? Date.now() < owed.retryAt : holderOf.get(phoneId) === citizenid) return;

  try {
    const [existing] = await repo.findAll({ phone_id: phoneId } as Partial<PhoneRow>);
    if (!existing) {
      await repo.create({ citizenid, phone_id: phoneId, claimed: 1 } as Partial<PhoneRow>);
      announceCreated(phoneId, citizenid);
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
    identityByCitizen.delete(citizenid);
  } catch (error) {
    // Not fatal and not cached: the id is on the item either way, so the next resolve retries.
    console.error(`[mica] could not record the phone row for ${phoneId}`, error);
  }
};

/** The citizen's phone that is bound to no item yet, or null. Lowest id when there are several. */
const readUnclaimed = async (citizenid: string): Promise<PhoneRow | null> => {
  const rows = await repo.findAll({ citizenid, claimed: 0 } as Partial<PhoneRow>);
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
 */
export const identityPhone = async (citizenid: string): Promise<string> => {
  const known = identityByCitizen.get(citizenid);
  if (known) {
    finishSetup(known, citizenid);
    return known;
  }

  const unclaimed = await readUnclaimed(citizenid);
  let phoneId: string;
  if (unclaimed) {
    phoneId = unclaimed.phone_id;
    finishSetup(phoneId, citizenid);
  } else {
    phoneId = newPhoneId();
    await repo.create({ citizenid, phone_id: phoneId, claimed: 0 } as Partial<PhoneRow>);
    announceCreated(phoneId, citizenid);
  }
  identityByCitizen.set(citizenid, phoneId);
  return phoneId;
};

/**
 * The phone a citizen is on, for a row written on their behalf — a notification, a photo
 * dropped onto them, a contact a job hands them, a call logged against them.
 *
 * Their active phone when this process has resolved one; else the phone they touched most
 * recently, which a handover and a claim both move `updated_at` for; else their identity
 * phone, created if they have none at all. The middle case is an offline player on a gated
 * server: nothing is in hand to ask, and the phone they last used is the best answer there is.
 */
export const phoneForCitizen = async (citizenid: string): Promise<string> => {
  const active = activeByCitizen.get(citizenid);
  if (active) return active;

  const latest = await Database.single<{ phone_id: string } | null>(
    `SELECT \`phone_id\` FROM \`mica_phones\` WHERE \`citizenid\` = ? AND \`status\` = 'active'
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

/**
 * The phone this source is using, minting one into the item the first time.
 *
 * **The rule lives here and nowhere else**, so no service re-implements it: the phone in the
 * slot this player last *used*, falling back to the lowest slot they hold. Last-used rather
 * than purely positional because a player switches phones by using one, which is visible,
 * where switching by dragging items between slots is not. `readItemSlots` returns slots
 * ascending precisely so the fallback is `slots[0]` rather than a sort somebody has to repeat.
 *
 * **An item with no id adopts the citizen's unclaimed phone before minting.** That is the
 * runtime half of the migration's backfill: the rows it re-keyed are on that phone, and the
 * first item in the player's hand is the one they should land on. Only when there is none is
 * a fresh id minted.
 *
 * **A minted id is written to the item before it is recorded**, and the resolve answers
 * `'unavailable'` if that write fails. The other order is worse: a row created for an id that
 * never reached the item is an orphan nothing will ever point at, where an id on an item with
 * no row yet is simply picked up and recorded by the next resolve.
 */
export const resolvePhone = async (src: number): Promise<PhoneResolution> => {
  const item = phoneItemName();
  if (!item) return UNAVAILABLE;

  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return UNAVAILABLE;

  const slots = FrameworkBridge.itemSlots(player, item);
  // `null` is "this inventory cannot say", never "holds none" — treating them alike would mint
  // a fresh phone on every resolve for a server that can never store one.
  if (slots === null) return UNAVAILABLE;
  if (slots.length === 0) return { status: 'none' };

  const preferred = lastUsedPhoneSlot(src);
  const chosen = slots.find((entry) => entry.slot === preferred) ?? slots[0];

  const carried = chosen.metadata.phoneId;
  if (typeof carried === 'string' && PHONE_ID.test(carried)) {
    await ensureHeld(carried, player.citizenid);
    finishSetup(carried, player.citizenid);
    activeByCitizen.set(player.citizenid, carried);
    activeBySource.set(src, carried);
    return { status: 'active', phone: { phoneId: carried, slot: chosen.slot } };
  }

  let adopted: string | null = null;
  try {
    adopted = (await readUnclaimed(player.citizenid))?.phone_id ?? null;
  } catch (error) {
    // A fresh id is the safe answer: nothing is lost, the unclaimed phone stays where it is.
    console.error(`[mica] could not look for ${player.citizenid}'s unclaimed phone`, error);
  }
  const phoneId = adopted ?? newPhoneId();

  if (!FrameworkBridge.setItemMetadata(player, item, chosen.slot, { phoneId })) {
    // `writeItemMetadata` has already said why, once. Claiming an id the item does not carry
    // would hand this player a different phone on their next relog.
    return UNAVAILABLE;
  }

  await ensureHeld(phoneId, player.citizenid);
  finishSetup(phoneId, player.citizenid);
  activeByCitizen.set(player.citizenid, phoneId);
  activeBySource.set(src, phoneId);
  return { status: 'active', phone: { phoneId, slot: chosen.slot } };
};

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

/**
 * The phone a request is for — what `ServiceEndpoint` asks before running a device-owned
 * action (MICA-282).
 *
 * Holding no phone on a gated server is a refusal the player can read, not a fallthrough: they
 * have no phone for rows to belong to, and the phone is closed for them anyway
 * (`deviceItem.ts`), so the only way this is reached is a client that opened it regardless.
 * Everything else that is not an item in hand degrades to the identity phone.
 */
export const phoneForRequest = async (src: number, citizenid: string): Promise<string> => {
  const resolution = await resolvePhone(src);
  if (resolution.status === 'active') return resolution.phone.phoneId;
  if (resolution.status === 'none') {
    throw new PlayerFacingError('You are not holding a phone.', { key: 'server.phone.notHeld' });
  }
  const identity = await identityPhone(citizenid);
  activeByCitizen.set(citizenid, identity);
  activeBySource.set(src, identity);
  return identity;
};

installPhoneResolvers({ forRequest: phoneForRequest, forCitizen: phoneForCitizen });
