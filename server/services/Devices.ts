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
import { defineService, SchemaRepository } from '../lib/defineService';
import { PlayerFacingError } from '../lib/errors';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import type { FrameworkPlayer } from '../lib/framework/runtime';
import { installDeviceResolvers, type RequestDeviceOptions } from '../lib/deviceIdentity';
import {
  deviceItemName,
  holdsDevice,
  holdsDeviceRead,
  installSlotJudge,
  isDeviceEnabled,
  lastUsedDeviceSlot,
  onDeviceStateChanged
} from '../lib/deviceItem';
import type { ItemSlot } from '../lib/framework/itemMetadata';
import { traceOf } from '../lib/sqlErrors';
import { who } from '../lib/who';

/**
 * The phone as a thing with an identity of its own (MICA-280, on MICA-279's seam), and the
 * thing every device-owned row belongs to (MICA-282).
 *
 * **Why this is its own table rather than `mica_phone_numbers`.** The number table is what a
 * phone *has*; this is what a phone *is*. MICA-284 moved the number onto the phone, and
 * MICA-282 moved contacts, notes, media and the rest — every table declared `deviceOwned`
 * carries a `device_id` that points here. `citizenid` on this row, as on every one of those,
 * is **the citizen who first used the phone, for good** (MICA-436). Nothing moves it: somebody
 * else holding the item gets nothing — the phone reads as not held for them, every device-owned
 * request is refused, and no row changes hands. See `settleHolder`.
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
 * notification never lands on a tablet, and a tablet never gets a number. The table, the
 * `device_id` column and the `deviceId` item-metadata key are named for any device, since
 * MICA-344, because both kinds share them.
 *
 * **Nothing here is reachable from a client.** Every generic action is off, so this
 * declaration registers no net event at all — a phone id is minted by the server and is never
 * something a payload sets, chooses or deletes (§2.9).
 */
export interface DeviceRow {
  id: number;
  citizenid: string;
  device_id: string;
  /** Which device this is (MICA-264). Fixed when the row is minted; nothing changes it. */
  kind: DeviceId;
  /** Bound to an inventory item, or still waiting for the first item its citizen uses. */
  claimed: number | boolean;
  /**
   * `1` from the insert until every new-device hook has finished (MICA-335). Absent on a row
   * read before `micaschema apply` added the column, which reads as finished.
   */
  setup_pending?: number | boolean;
  status: string;
  updated_at?: Date | string;
}

/**
 * The devices table's repository, with the one write the generic path has no shape for: marking
 * a device's set-up finished, keyed on the device id alone. Server-internal — nothing reaching
 * it comes from a payload; the id is one this server minted or read back, and the hooks it
 * vouches for have just run for it.
 */
class DeviceRepository extends SchemaRepository<DeviceRow> {
  /**
   * Clear `setup_pending`. `updated_at` is pinned: `phoneForCitizen` reads it as "the phone
   * this citizen used last", and finishing a set-up is not using one.
   */
  async markSetupFinished(deviceId: string): Promise<boolean> {
    return await Database.update(
      `UPDATE \`${this.tableName}\` SET \`setup_pending\` = 0, \`updated_at\` = \`updated_at\` ` +
        'WHERE `device_id` = ? AND `setup_pending` <> 0',
      [deviceId]
    );
  }
}

export const devices = defineService<DeviceRow>({
  id: 'devices',
  table: 'mica_devices',
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
    device_id: { type: 'string', length: 32, notNull: true, clientWritable: false },
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
    claimed: { type: 'bool', notNull: true, default: 0, clientWritable: false },
    /**
     * Whether the device's new-device hooks still owe it anything (MICA-335): the durable half
     * of `owedSetup`, so a restart between a hook failing and its retry no longer forgets the
     * retry. Every insert below writes `1`, and `runCreated` clears it once every hook has
     * finished; the first resolve of a device after a start reads it with the row it already
     * reads, and runs the hooks again when it is still set.
     *
     * **Defaulted to `0`, and that default is the upgrade.** `micaschema apply`'s additive half
     * adds the column with `DEFAULT 0`, which MariaDB writes into every row already there, so
     * every device that existed before this column reads as set up — its hooks ran, or ran
     * and failed under MICA-327's in-process retry, and either way re-running them on every
     * phone at once is the outcome this must never have. A `NULL`-able "done at" timestamp
     * would have read every existing row as unfinished. A row read before the column exists
     * has no value at all, which reads as finished too. A `tinyint` for the reason `claimed`
     * is one.
     */
    setup_pending: { type: 'bool', notNull: true, default: 0, clientWritable: false }
  },
  indexes: [
    // Uniqueness is the schema's job. Two phones sharing an id would be two players sharing a
    // phone now that MICA-282 keys rows on it.
    // Not unique on citizenid, deliberately: the whole point of MICA-219 is that a character
    // may hold several phones. `defineService` already emits a `citizenid_status` key, and a
    // lookup by citizenid alone uses its leading column, so no separate one is declared here.
    { name: 'device_id_unique', columns: ['device_id'], unique: true }
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
  },
  repositoryFactory: (resolved) => new DeviceRepository(resolved)
});

const repo = devices.repo as DeviceRepository;

/** What a minted id looks like, and the only shape trusted off item metadata. */
const DEVICE_ID = /^[0-9a-f]{32}$/;

const newDeviceId = (): string => randomBytes(16).toString('hex');

/** One map per device kind (MICA-264): a phone and a tablet are two answers, never one. */
const byKind = <K, V>(): Record<DeviceId, Map<K, V>> =>
  Object.fromEntries(ALL_DEVICES.map((kind) => [kind, new Map<K, V>()])) as Record<
    DeviceId,
    Map<K, V>
  >;

/**
 * Whose each device is, once this process has read its row claimed or written it (MICA-436), so
 * neither the owner's resolve nor the refusal of anybody else is a query. A row's `citizenid` is
 * the citizen who first used the device and nothing moves it, so an entry is never invalidated:
 * like `kindOf`, it only saves the read. An unclaimed row is left out on purpose — its citizen
 * still has to claim it, and that write is what the read in `settleHolder` is for.
 */
const ownerOf = new Map<string, string>();
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
const activeBySource = byKind<number, { deviceId: string; citizenid: string }>();
/** Each citizen's identity device of each kind, once found or minted. */
const identityByCitizen = byKind<string, string>();

/**
 * Whoever sets a phone up the first time it exists (MICA-234) — `Contacts.ts`, which seeds the
 * owner's default contacts. A hook is handed the new row's `kind` (MICA-264) and decides for
 * itself what a tablet gets; the default contacts are a phone's, so a tablet gets none.
 * Registered here rather than imported: this file must not import the services that key on it.
 *
 * "New" means this server just inserted the phone's `mica_devices` row, which happens once per
 * phone id (`device_id_unique`) and never again: nothing deletes a phone row, a claim updates
 * the one that exists, and the rows `0002_phone_data_follows_the_phone` backfilled
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
 * nothing the first already wrote. The phone row's existence cannot be the mark that a hook
 * *finished*, only that the phone is new, because it is inserted before any hook runs; its
 * `setup_pending` column is that mark (MICA-335), so a restart between a failure and its retry
 * runs **every** hook again on the phone's first resolve after the start — the ones that had
 * already succeeded included, since nothing durable says which those were. Every run is handed
 * the phone's owner, who is who it was created for: nothing moves a phone to anybody else
 * (MICA-436).
 *
 * **A hook must never await `resolvePhone`, `deviceForRequest`, `activePhone` or anything else
 * that reaches `ensureHeld` for the same phone.** Hooks run on the phone's queue
 * (`queueOnDevice`), and a resolve that has to settle a phone joins that queue behind the hook
 * awaiting it — neither ever finishes, and every later uncached resolve of the phone waits
 * behind both. A hook is handed the phone id and the holder for exactly that reason.
 */
type CreatedRun = (
  deviceId: string,
  citizenid: string,
  kind: DeviceId
) => Promise<unknown> | unknown;
type CreatedHook = { name: string; run: CreatedRun };
const createdHooks: CreatedHook[] = [];

export const onDeviceCreated = (name: string, run: CreatedRun): void => {
  createdHooks.push({ name, run });
};

/**
 * New-phone hooks that threw, by phone, and when to try them again (MICA-327). The in-process
 * half, which keeps a retry narrow — only the hooks that failed — and backed off. The durable
 * half is `setup_pending` on the row (MICA-335): a restart drops this map, and the first resolve
 * after it reads the column and puts every hook back here (`resumeSetup`).
 */
interface OwedSetup {
  /** What is left to run. Empty when every hook finished and only the mark failed to land. */
  hooks: readonly CreatedHook[];
  /** The kind the row was minted as, handed to every retry as it was to the first run. */
  kind: DeviceId;
  failures: number;
  /** No retry before this; `Infinity` while one is already queued. */
  retryAt: number;
}
const owedSetup = new Map<string, OwedSetup>();

/**
 * Run these hooks for this phone, each its own failure, and remember any that threw. Never
 * rejects. Only ever run from the phone's queue (`queueOnDevice`), so it cannot overlap
 * another run for the phone, which is what keeps an idempotent hook from doubling. `citizenid`
 * is the phone's owner: every caller is a resolve that found the phone theirs (MICA-436).
 *
 * **The row is marked finished only once nothing is left** (MICA-335), and only after the last
 * hook, so the mark can never land over work that did not. A mark that fails to land is owed
 * like a hook: kept with no hooks left to run, and written again on a later resolve. Until it
 * lands a restart runs every hook again, which they are idempotent for.
 */
const runCreated = async (
  deviceId: string,
  citizenid: string,
  kind: DeviceId,
  hooks: readonly CreatedHook[],
  owed: OwedSetup | undefined
): Promise<void> => {
  const failures = (owed?.failures ?? 0) + 1;
  const wait = retryDelay(failures);
  const when =
    wait === 0
      ? "on the phone's next resolve"
      : `no sooner than ${wait / 1000}s from now, on the phone's next resolve`;
  const failed: CreatedHook[] = [];
  for (const hook of hooks) {
    try {
      await hook.run(deviceId, citizenid, kind);
    } catch (error) {
      failed.push(hook);
      console.error(
        `[mica] new-phone hook '${hook.name}' failed for phone ${who(deviceId)} ` +
          `(attempt ${failures}); retrying ${when}.`,
        traceOf(error)
      );
    }
  }
  if (failed.length > 0) {
    owedSetup.set(deviceId, { hooks: failed, kind, failures, retryAt: Date.now() + wait });
    return;
  }
  try {
    await repo.markSetupFinished(deviceId);
  } catch (error) {
    console.error(
      `[mica] phone ${who(deviceId)}'s set-up finished, but could not be recorded as finished ` +
        `(attempt ${failures}); retrying ${when}.`,
      traceOf(error)
    );
    owedSetup.set(deviceId, { hooks: [], kind, failures, retryAt: Date.now() + wait });
    return;
  }
  owedSetup.delete(deviceId);
};

/** Does this row say its set-up is still owed (MICA-335)? A row with no such column says not. */
const setupPending = (row: Pick<DeviceRow, 'setup_pending'>): boolean =>
  Number(row.setup_pending) === 1;

/**
 * A device row read back with `setup_pending` still set (MICA-335): its hooks did not all
 * finish before the process that created it stopped, so this one owes them — every hook, since
 * nothing durable says which already succeeded, run on the device's queue by the `finishSetup`
 * that follows this read. Nothing is done when this process already owes the device a run, or
 * when the row was marked finished. Called where a resolve reads the row anyway, so this costs
 * no query of its own: `judgeRow` once per device per process, `identityDevice` once per
 * citizen. Recorded on any read of the row, whoever it was for; run by the owner's resolve.
 */
const resumeSetup = (
  deviceId: string,
  row: Pick<DeviceRow, 'setup_pending'>,
  kind: DeviceId
): void => {
  if (!setupPending(row) || owedSetup.has(deviceId)) return;
  owedSetup.set(deviceId, { hooks: createdHooks, kind, failures: 0, retryAt: 0 });
  console.log(
    `[mica] phone ${who(deviceId)}'s set-up did not finish before micaOS last stopped; ` +
      'running it again.'
  );
};

/**
 * The phone row was just inserted: queue every hook behind whatever the phone is doing. Owed
 * from this moment rather than from the first failure, so a read of the row while the first
 * run is still queued — `setup_pending` is set — is not taken for one a restart left behind
 * (`resumeSetup`); `retryAt` is `Infinity` because the run is already queued.
 */
const announceCreated = (deviceId: string, citizenid: string, kind: DeviceId): void => {
  kindOf.set(deviceId, kind);
  const owed: OwedSetup = {
    hooks: createdHooks,
    kind,
    failures: 0,
    retryAt: Number.POSITIVE_INFINITY
  };
  owedSetup.set(deviceId, owed);
  void queueOnDevice(deviceId, () => runCreated(deviceId, citizenid, kind, createdHooks, owed));
};

/**
 * Retry whatever a new phone's hooks left, if anything, without holding up the resolve that
 * calls it: queued, not awaited, so the **next** call for the phone waits behind it instead.
 * One map lookup when nothing is owed, which is every phone but a new one whose hooks have not
 * all finished — in this process, or in one before it (`resumeSetup`); backed off
 * (`retryDelay`), so a hook that keeps failing is one attempt per wait.
 */
const finishSetup = (deviceId: string, citizenid: string): void => {
  const owed = owedSetup.get(deviceId);
  if (!owed || Date.now() < owed.retryAt) return;
  owed.retryAt = Number.POSITIVE_INFINITY;
  void queueOnDevice(deviceId, () => {
    const current = owedSetup.get(deviceId);
    return current
      ? runCreated(deviceId, citizenid, current.kind, current.hooks, current)
      : undefined;
  });
};

/**
 * How long to wait before running a new phone's set-up again, by how many attempts in a row
 * have failed (MICA-327). The first retry is the next resolve — most failures are a dropped
 * connection or a lock wait, gone a moment later — and a hook that keeps failing settles at
 * one attempt, and one log line, every ten minutes rather than one per request.
 */
const RETRY_AFTER_MS = [0, 5_000, 30_000, 120_000, 600_000];
const retryDelay = (failures: number): number =>
  RETRY_AFTER_MS[Math.min(failures, RETRY_AFTER_MS.length) - 1];

/**
 * The work queued for each phone — `ensureHeld`, and since MICA-327 the new-phone hooks — which
 * the next call for that phone waits behind (MICA-319). Two set-up runs for one phone would
 * otherwise overlap and double an idempotent hook's rows, and a resolve settling the phone
 * would create or claim the row under a hook still seeding it. An entry is deleted when the
 * last call chained onto it settles, so this holds only phones with a call in flight.
 */
const settling = new Map<string, Promise<void>>();

/**
 * Run `work` for this phone once everything already queued for it has settled, and answer
 * when it has. The queue is `ensureHeld` and the new-phone hooks (MICA-327), so neither runs
 * under the other.
 */
const queueOnDevice = (deviceId: string, work: () => Promise<void> | void): Promise<void> => {
  const run = async (): Promise<void> => {
    await work();
  };
  const next = (settling.get(deviceId) ?? Promise.resolve()).then(run, run);
  settling.set(deviceId, next);
  const forget = (): void => {
    if (settling.get(deviceId) === next) settling.delete(deviceId);
  };
  void next.then(forget, forget);
  return next;
};

/** Test seam: module state that would otherwise leak between cases. Hooks are registrations and stay. */
export const __resetDeviceState = (): void => {
  ownerOf.clear();
  kindOf.clear();
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
 * `resolvePhone`/`deviceForRequest` for this source found. Every device-owned request
 * refreshes it, and so does the sync `deviceItem.ts` fires on load, use and inventory change,
 * so it is stale for at most the gap between using a phone and the server hearing about it.
 */
export const activePhoneIdOf = (src: number): string | null =>
  activeBySource.phone.get(src)?.deviceId ?? null;

/**
 * `activePhoneIdOf` for any device kind (MICA-264): the device of that kind a connected source
 * last resolved to, or null. `LockState` keys a tablet's external lock on it.
 */
export const activeDeviceIdOf = (src: number, kind: DeviceId): string | null =>
  activeBySource[kind].get(src)?.deviceId ?? null;

on('playerDropped', () => {
  for (const kind of ALL_DEVICES) activeBySource[kind].delete(source);
});

/** The phone a player is currently on. */
export interface ActiveDevice {
  deviceId: string;
  slot: number;
}

/**
 * What a carried id comes to for the citizen holding it (MICA-436).
 *
 * - `own`: the citizen's device — its row names them, or there was no row and one now does.
 * - `foreign`: its row names somebody else. A phone belongs to the citizen who first used it,
 *   for good, so nothing is written, walked or claimed, and the slot is skipped.
 * - `otherKind`: its row is another kind of device (MICA-264). Nothing is written either; the
 *   item is given an id of its own kind.
 * - `unread`: the row could not be read, so nobody can say.
 * - `unrecorded`: the row is, or would be, the citizen's, but the create or the claim that makes
 *   it so failed. Refused like `unread` (MICA-436 review): a phone with no row is nobody's yet,
 *   and anything written on it now — rows, a number — would go to whoever's resolve next creates
 *   the row, which need not be this citizen if the item changes hands first. The next resolve
 *   tries the write again.
 */
type Settled =
  | { outcome: 'own' }
  | { outcome: 'foreign' }
  | { outcome: 'otherKind'; kind: DeviceId }
  | { outcome: 'unread' }
  | { outcome: 'unrecorded' };

const OWN: Settled = { outcome: 'own' };
const FOREIGN: Settled = { outcome: 'foreign' };
const UNREAD: Settled = { outcome: 'unread' };
const UNRECORDED: Settled = { outcome: 'unrecorded' };

/** A row's kind; a row read before `kind` existed is a phone, as `micaschema apply` fills it. */
const rowKind = (row: Pick<DeviceRow, 'kind'>): DeviceId =>
  isDeviceId(row.kind) ? row.kind : DEFAULT_DEVICE;

/** What this process already knows of a carried id, without a query; `null` until it reads one. */
const knownSettled = (deviceId: string, citizenid: string, kind: DeviceId): Settled | null => {
  const recorded = kindOf.get(deviceId);
  if (recorded !== undefined && recorded !== kind) return { outcome: 'otherKind', kind: recorded };
  const owner = ownerOf.get(deviceId);
  if (owner === undefined) return null;
  return owner === citizenid ? OWN : FOREIGN;
};

/**
 * **The rule** (MICA-436), over the row a carried id reads back: what the id is to this
 * citizen. The one decision `resolveDevice` settles a slot by and the item gate counts a slot
 * by (`usableSlot`), so the shell opens for exactly the players a device-owned request answers.
 *
 * No row is the holder's to record: an id on an item with no row is one whose create failed
 * after the item write, and the next resolve picks it up. A row naming somebody else is theirs,
 * claimed or not — an unclaimed one is adopted only by the citizen it names. Records what the
 * read taught this process: the row's kind, its owner once claimed, and a set-up a restart
 * left owed (`resumeSetup`).
 *
 * **The set-up is recorded whoever read the row**, the owner or not. Once the owner is cached
 * the owner's own resolve never reads the row again in this process, so a read on somebody
 * else's behalf that skipped it would leave a set-up a restart interrupted owed for good. It
 * only records: `finishSetup` runs it, and only a resolve that found the phone its caller's
 * reaches that, so it runs for the owner.
 */
const judgeRow = (
  deviceId: string,
  row: DeviceRow | undefined,
  citizenid: string,
  kind: DeviceId
): Settled => {
  if (!row) return OWN;
  const recorded = rowKind(row);
  kindOf.set(deviceId, recorded);
  if (recorded !== kind) return { outcome: 'otherKind', kind: recorded };
  resumeSetup(deviceId, row, recorded);
  if (Number(row.claimed)) ownerOf.set(deviceId, row.citizenid);
  return row.citizenid === citizenid ? OWN : FOREIGN;
};

/**
 * Settle a carried id for the citizen holding it, without paying a query on every resolve.
 *
 * Keyed on `device_id` rather than the row id, because the id in item metadata is all a caller
 * has. The hot path answers from `ownerOf` and `kindOf` without joining the queue: the owner,
 * and anybody else, once the row has been read claimed. Queuing it would make every resolve of
 * a new phone wait behind its seed, which can be minutes of lock waits (MICA-327). Anything that
 * could need writing — a first resolve, a row still unclaimed — misses here and queues.
 *
 * **Calls for one phone run one after another** (`settling`), so each reads what the one
 * before it recorded rather than racing it.
 */
const ensureHeld = async (
  deviceId: string,
  citizenid: string,
  kind: DeviceId
): Promise<Settled> => {
  const known = knownSettled(deviceId, citizenid, kind);
  if (known) return known;
  let settled: Settled = UNREAD;
  await queueOnDevice(deviceId, async () => {
    settled = await settleHolder(deviceId, citizenid, kind);
  });
  return settled;
};

/**
 * Read the row and act on `judgeRow`'s answer (MICA-436). Three outcomes write something, and
 * only for the citizen the row is, or will be: no row yet, so one is created already claimed
 * (the id is on an item); the citizen's own row still unclaimed, which this claims; the
 * citizen's own row claimed, which needs nothing. A row naming somebody else, or of another
 * kind, is answered with nothing written.
 *
 * **A create or a claim that fails is `unrecorded`, and the resolve is refused** (MICA-436
 * review). Answering the phone anyway used to file this request's rows, and its number, on an id
 * with no row — and if the item changed hands before the next resolve, that one created the row
 * for its own citizen, who then owned the phone and everything filed on it. Nothing is cached,
 * so the next resolve reads again and retries the write; the id is on the item either way. A
 * create that loses a race with a concurrent one violates `device_id_unique` and is refused the
 * same way, and the next resolve reads the winner.
 */
const settleHolder = async (
  deviceId: string,
  citizenid: string,
  kind: DeviceId
): Promise<Settled> => {
  // Settled meanwhile by a call queued ahead of this one.
  const known = knownSettled(deviceId, citizenid, kind);
  if (known) return known;

  let read = false;
  try {
    const [existing] = await repo.findAll({ device_id: deviceId } as Partial<DeviceRow>);
    read = true;
    const judged = judgeRow(deviceId, existing, citizenid, kind);
    if (judged.outcome !== 'own') return judged;
    if (!existing) {
      await repo.create({
        citizenid,
        device_id: deviceId,
        kind,
        claimed: 1,
        setup_pending: 1
      } as Partial<DeviceRow>);
      announceCreated(deviceId, citizenid, kind);
    } else if (!Number(existing.claimed)) {
      await repo.update(existing.id, { claimed: 1 } as Partial<DeviceRow>, citizenid);
    }
    ownerOf.set(deviceId, citizenid);
    identityByCitizen[kind].delete(citizenid);
    return OWN;
  } catch (error) {
    console.error(`[mica] could not record the phone row for ${who(deviceId)}`, traceOf(error));
    // Read, and the citizen's or absent, but not written: refused, and nothing is cached, so
    // the next resolve tries the write again. Not read at all: nobody can say.
    return read ? UNRECORDED : UNREAD;
  }
};

/**
 * Whether a citizen may use the device in this slot (MICA-436), from what this process knows:
 * `null` for a carried id whose row it has not read. A slot is usable unless it carries an id
 * whose row names somebody else — a blank slot, or one carrying an id of no shape this server
 * writes, is minted into; one carrying an id of the other kind is minted over; one with no row
 * yet is recorded as the holder's. `knownSettled` is the same answer `ensureHeld` takes.
 */
const usableNow = (citizenid: string, kind: DeviceId, slot: ItemSlot): boolean | null => {
  const carried = slot.metadata.deviceId;
  if (typeof carried !== 'string' || !DEVICE_ID.test(carried)) return true;
  const known = knownSettled(carried, citizenid, kind);
  return known === null ? null : known.outcome !== 'foreign';
};

/**
 * `usableNow`, reading the row when this process has not — `judgeRow` over it, so the answer
 * is the one the resolve would settle the slot to. Reads and never writes: a slot is only
 * claimed, minted or created by a resolve.
 */
const usableSlot = async (citizenid: string, kind: DeviceId, slot: ItemSlot): Promise<boolean> => {
  const now = usableNow(citizenid, kind, slot);
  if (now !== null) return now;
  const carried = slot.metadata.deviceId as string;
  const [row] = await repo.findAll({ device_id: carried } as Partial<DeviceRow>);
  return judgeRow(carried, row, citizenid, kind).outcome !== 'foreign';
};

/** The order a resolve tries slots in: the one last used first, then the rest ascending. */
const slotOrder = (slots: readonly ItemSlot[], preferred: number | undefined): ItemSlot[] => {
  const first = slots.find((entry) => entry.slot === preferred);
  return first ? [first, ...slots.filter((entry) => entry !== first)] : [...slots];
};

/**
 * The citizen's device of this kind that is bound to no item yet, or null. Lowest id when there
 * are several. By kind (MICA-264), so a phone item never adopts a tablet's identity row.
 */
const readUnclaimed = async (citizenid: string, kind: DeviceId): Promise<DeviceRow | null> => {
  const rows = await repo.findAll({ citizenid, kind, claimed: 0 } as Partial<DeviceRow>);
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
  let deviceId: string;
  if (unclaimed) {
    deviceId = unclaimed.device_id;
    kindOf.set(deviceId, kind);
    resumeSetup(deviceId, unclaimed, kind);
    finishSetup(deviceId, citizenid);
  } else {
    deviceId = newDeviceId();
    await repo.create({
      citizenid,
      device_id: deviceId,
      kind,
      claimed: 0,
      setup_pending: 1
    } as Partial<DeviceRow>);
    announceCreated(deviceId, citizenid, kind);
  }
  identityByCitizen[kind].set(citizenid, deviceId);
  return deviceId;
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
 * recently, which a claim moves `updated_at` for; else their identity phone, created if they
 * have none at all. The middle case is an offline player on a gated server: nothing is in hand
 * to ask, and the phone they last used is the best answer there is.
 *
 * **The cached phone is always the citizen's own** (MICA-436). `activeByCitizen` is written
 * only by a resolve that found the phone theirs, and cleared by none, so after a robbery it
 * still names the phone the thief now holds — which is right: the thief is refused it, and
 * what is filed there under its owner waits on it for them, as it would in a stash (MICA-339's
 * decision). Before MICA-436 the thief's next resolve moved those rows to them.
 */
export const phoneForCitizen = async (citizenid: string): Promise<string> => {
  const active = activeByCitizen.phone.get(citizenid);
  if (active) return active;

  // Phones only (MICA-264): a call logged against an offline player, or a notification for
  // one, must never land on the tablet they happened to touch last.
  const latest = await Database.single<{ device_id: string } | null>(
    `SELECT \`device_id\` FROM \`mica_devices\`
     WHERE \`citizenid\` = ? AND \`kind\` = 'phone' AND \`status\` = 'active'
     ORDER BY \`updated_at\` DESC, \`id\` DESC LIMIT 1`,
    [citizenid]
  );
  if (latest?.device_id) return latest.device_id;

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
export type DeviceResolution =
  | { status: 'active'; device: ActiveDevice }
  /** A phone item is required here and this player holds none. */
  | { status: 'none' }
  /** No phone identity can be had on this server, or for this source, right now. */
  | { status: 'unavailable' };

const UNAVAILABLE: DeviceResolution = { status: 'unavailable' };
const NONE: DeviceResolution = { status: 'none' };

/** Record a device as the one this source and its citizen are on now. */
const markActive = (src: number, citizenid: string, kind: DeviceId, deviceId: string): void => {
  activeByCitizen[kind].set(citizenid, deviceId);
  activeBySource[kind].set(src, { deviceId, citizenid });
};

/**
 * Drop the device of this kind a source was last on, when a resolve finds it is no longer
 * theirs (MICA-264) — unless it was resolved for `keep`, the character the source has now.
 *
 * A resolve that answers `'none'` passes no `keep`: they hold none, so whatever was cached is
 * somebody else's now, or nobody's, and `LockPhone` must not key it. One that answers
 * `'unavailable'` passes the current character: on a server that cannot carry an id that
 * answer is the steady state, and the identity device `deviceForRequest` cached for this same
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
 * ascending precisely so the fallback is the first one rather than a sort somebody has to
 * repeat. Each kind has its own item, its own last-used slot and its own rows (MICA-264).
 *
 * **A slot carrying somebody else's device is skipped** (MICA-436): a phone belongs to the
 * citizen who first used it, for good. The last-used slot wins only when it is the player's own
 * or theirs to claim, and the fallback is the lowest such slot; a player holding nothing but
 * other people's phones holds none, `'none'`, and is refused every device-owned request with
 * `server.phone.notHeld`. Nothing is written for a skipped slot. `judgeRow` is the rule, and the
 * item gate (`lib/deviceItem.ts`) counts by it too, so the shell stays shut for such a player.
 *
 * **A carried id must name a row of the same kind** (MICA-264), or it is refused and the item
 * is given a fresh one, as an item with no id is. `ensureHeld` answers the kind from the one
 * read of the row it already makes, and writes nothing for a row of another kind. Both items
 * carry the id under the same `deviceId` key, so without this a phone id copied onto a tablet
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
 *
 * `player` is the one the caller already looked up for this source (MICA-362), so a request
 * does not walk the framework's player table twice; absent, it is looked up here.
 */
export const resolveDevice = async (
  src: number,
  kind: DeviceId,
  player?: FrameworkPlayer
): Promise<DeviceResolution> => (await resolveCounted(src, kind, player)).resolution;

/**
 * `resolveDevice`, and what it learned on the way that `deviceForRequest` needs for the in-hand
 * check (MICA-362): the player it resolved for, and whether the inventory listed its slots. A
 * listed answer is the count — slots, or none — so the check asks nothing more; an unlisted
 * one (`itemSlots` is `null`) is a server where only a count can say.
 */
interface CountedResolution {
  resolution: DeviceResolution;
  player: FrameworkPlayer | null;
  listed: boolean;
}

/** A resolve refused because the device's row could not be written (`Settled`'s `unrecorded`). */
const unrecorded = (deviceId: string): Error =>
  new Error(
    `[mica] could not record the row for ${who(deviceId)}; refusing the resolve, and the next ` +
      'one tries again.'
  );

const resolveCounted = async (
  src: number,
  kind: DeviceId,
  given?: FrameworkPlayer
): Promise<CountedResolution> => {
  // An off device has no item to hold. `ServiceEndpoint` refuses its requests before this.
  if (!isDeviceEnabled(kind)) {
    forgetActive(src, kind);
    return { resolution: NONE, player: null, listed: false };
  }
  const player = given ?? FrameworkBridge.getPlayer(src);
  let listed = false;
  const answer = (resolution: DeviceResolution): CountedResolution => ({
    resolution,
    player,
    listed
  });
  const unavailable = (): CountedResolution => {
    forgetActive(src, kind, player?.citizenid);
    return answer(UNAVAILABLE);
  };

  const item = deviceItemName(kind);
  if (!item) return unavailable();
  if (!player?.citizenid) return unavailable();

  const slots = FrameworkBridge.itemSlots(player, item);
  // `null` is "this inventory cannot say", never "holds none" — treating them alike would mint
  // a fresh phone on every resolve for a server that can never store one.
  if (slots === null) return unavailable();
  listed = true;
  if (slots.length === 0) {
    forgetActive(src, kind);
    return answer(NONE);
  }

  // The first slot, in the order the rule prefers, that is this citizen's to use (MICA-436).
  let chosen: ItemSlot | null = null;
  for (const slot of slotOrder(slots, lastUsedDeviceSlot(src, kind))) {
    const carried = slot.metadata.deviceId;
    if (typeof carried !== 'string' || !DEVICE_ID.test(carried)) {
      chosen = slot;
      break;
    }
    const settled = await ensureHeld(carried, player.citizenid, kind);
    // Somebody else's phone: theirs for good, and skipped as though it were not held.
    if (settled.outcome === 'foreign') continue;
    if (settled.outcome === 'own') {
      finishSetup(carried, player.citizenid);
      markActive(src, player.citizenid, kind, carried);
      return answer({ status: 'active', device: { deviceId: carried, slot: slot.slot } });
    }
    if (settled.outcome === 'unread') {
      // Which device this id is could not be read. Using it might be a phone id on a tablet;
      // minting over it might be overwriting a real device's id. Neither, until a read works.
      throw new Error(
        `[mica] could not read which device ${who(carried)} is; refusing the resolve.`
      );
    }
    // Theirs, but its row could not be written: nothing may land on it yet (`Settled`).
    if (settled.outcome === 'unrecorded') throw unrecorded(carried);
    // The one sign an operator gets of a tampered or mixed-up item. By token since MICA-433,
    // and without the slot, which said nothing an operator acts on.
    console.warn(
      `[mica] ${who(player.citizenid)}'s ${kind} item carried ${who(carried)}, which is a ` +
        `${settled.kind}. Refused; the item is given a ${kind} id of its own.`
    );
    chosen = slot;
    break;
  }
  // Every slot held is somebody else's device: as good as holding none.
  if (!chosen) {
    forgetActive(src, kind);
    return answer(NONE);
  }

  let adopted: string | null = null;
  if (kind === 'phone') {
    try {
      adopted = (await readUnclaimed(player.citizenid, kind))?.device_id ?? null;
    } catch (error) {
      // A fresh id is the safe answer: nothing is lost, the unclaimed phone stays where it is.
      console.error(
        `[mica] could not look for ${who(player.citizenid)}'s unclaimed phone`,
        traceOf(error)
      );
    }
  }
  const deviceId = adopted ?? newDeviceId();

  if (!FrameworkBridge.setItemMetadata(player, item, chosen.slot, { deviceId })) {
    // `writeItemMetadata` has already said why, once. Claiming an id the item does not carry
    // would hand this player a different phone on their next relog.
    return unavailable();
  }

  // Its kind is this one and its owner this citizen by construction — a fresh id has no row,
  // and an adopted one was read by kind and citizenid — so `ensureHeld` answers `own`, unless
  // the row could not be read or written. Then the request is refused (MICA-436 review): the id
  // is already on the item, and the next resolve reads it there and tries the row again.
  const minted = await ensureHeld(deviceId, player.citizenid, kind);
  if (minted.outcome !== 'own') throw unrecorded(deviceId);
  finishSetup(deviceId, player.citizenid);
  markActive(src, player.citizenid, kind, deviceId);
  return answer({ status: 'active', device: { deviceId, slot: chosen.slot } });
};

/**
 * The phone this source is using: `resolveDevice` for the phone. Kept as its own name because
 * the number sync (`PhoneNumbers.ts`) and `GetPhoneNumber` are the phone's alone, and a tablet
 * must never reach either.
 */
export const resolvePhone = (src: number): Promise<DeviceResolution> => resolveDevice(src, 'phone');

/**
 * The phone this source is using, or `null` when they have no phone identity right now.
 *
 * `resolvePhone` with its three answers folded to one, for a caller that does not need to
 * tell "holds none" from "cannot say".
 */
export const activePhone = async (src: number): Promise<ActiveDevice | null> => {
  const resolution = await resolvePhone(src);
  return resolution.status === 'active' ? resolution.device : null;
};

/** What a player who holds none of a device is told. The phone keeps its own MICA-282 key. */
const notHeld = (device: DeviceId): PlayerFacingError =>
  device === 'phone'
    ? new PlayerFacingError('You are not holding a phone.', { key: 'server.phone.notHeld' })
    : new PlayerFacingError(`You are not holding a ${DEVICES[device].label.toLowerCase()}.`, {
        key: 'server.device.notHeld',
        params: { device: DEVICES[device].label }
      });

/** What a request naming a device this server has off is told. */
const turnedOff = (device: DeviceId): PlayerFacingError =>
  new PlayerFacingError(
    `The ${DEVICES[device].label.toLowerCase()} is turned off on this server.`,
    {
      key: 'server.device.off',
      params: { device: DEVICES[device].label }
    }
  );

/**
 * The device a request is for — what `ServiceEndpoint` asks before running a device-owned
 * action (MICA-282), for whichever device the request named (MICA-264).
 *
 * Holding none on a gated server is a refusal the player can read, not a fallthrough: they
 * have no device for rows to belong to, and it is closed for them anyway (`deviceItem.ts`), so
 * the only way this is reached is a client that opened it regardless. Everything else that is
 * not an item in hand degrades to the citizen's identity device of that kind.
 *
 * **`requireHeld` makes it `requireDeviceInHand` too** (MICA-362), from the same slot read: a
 * request that is both a claim to hold the device and scoped by it used to count the item and
 * then list its slots, two inventory reads for one question. An off device is refused first,
 * with the same `server.device.off` toast. A listed inventory has already answered — slots in
 * hand or `'none'` — and only one that cannot list (`itemSlots` is `null`, es_extended's own
 * inventory) is counted, so the check is never weaker than `holdsDevice` and fails open exactly
 * where it does. Nothing is kept: the next request reads the slots again, because that read is
 * the proof the device is still in hand after a robbery.
 */
export const deviceForRequest = async (
  src: number,
  citizenid: string,
  device: DeviceId = DEFAULT_DEVICE,
  options: RequestDeviceOptions = {}
): Promise<string> => {
  if (options.requireHeld && !isDeviceEnabled(device)) throw turnedOff(device);
  const { resolution, player, listed } = await resolveCounted(src, device, options.player);
  if (resolution.status === 'active') return resolution.device.deviceId;
  if (resolution.status === 'none') throw notHeld(device);
  // Unavailable. A listed inventory saw the device in hand (the item write failed after it);
  // one that could not list is counted, as `requireDeviceInHand` would, and a request with no
  // player to count is refused rather than waved through.
  if (options.requireHeld && !listed && !(player && holdsDevice(player, device))) {
    throw notHeld(device);
  }
  const identity = await identityDevice(citizenid, device);
  markActive(src, citizenid, device, identity);
  return identity;
};

/**
 * Refuse a request that names a device this server has off, or one the player holds none of
 * (MICA-264) — for every service, device-owned or not, since a request from the tablet is
 * a claim to be holding one. Answered now, through the same `holdsDevice` the item gate uses,
 * so it fails open exactly where that does: no gate configured, standalone, or an inventory
 * that cannot count. Synchronous, so a slot carrying an id whose row this process has not read
 * yet counts as held (MICA-436): for the call-answer path, which cannot yield. A request is held
 * to `requireDeviceInHandRead` or to `resolveDevice`, which both read.
 */
export const requireDeviceInHand = (player: FrameworkPlayer, device: DeviceId): void => {
  if (!isDeviceEnabled(device)) throw turnedOff(device);
  if (!holdsDevice(player, device)) throw notHeld(device);
};

/**
 * `requireDeviceInHand`, reading every slot's row this process has not seen first (MICA-436
 * review) — what `ServiceEndpoint` holds a request to. A holder of nothing but somebody else's
 * phone passed the synchronous check until something else read that row, and a modified client
 * can keep anything else from ever reading it, so a request that moves money or publishes reads
 * it itself. One read per unseen id, cached after (`judgeRow`).
 */
export const requireDeviceInHandRead = async (
  player: FrameworkPlayer,
  device: DeviceId
): Promise<void> => {
  if (!isDeviceEnabled(device)) throw turnedOff(device);
  if (!(await holdsDeviceRead(player, device))) throw notHeld(device);
};

/**
 * Re-resolve a non-phone device whenever `deviceItem.ts` says it may have changed (MICA-264):
 * a load, a relayed inventory change, a use of its item. The phone's own subscribers (the
 * number sync, the battery) already resolve the phone on those occasions, which refreshes or
 * clears its entry the same way; this gives the tablet the same, so `LockPhone(src, 'tablet')`
 * after a switch, a robbery or a character switch keys the tablet in hand, not the last one a
 * device-owned request happened to resolve. Nothing is minted for a tablet nobody holds: a
 * resolve that finds none clears the entry and writes nothing.
 */
onDeviceStateChanged('device-identity', (src, device) => resolveDevice(src, device));

installDeviceResolvers({
  forRequest: deviceForRequest,
  forCitizen: phoneForCitizen,
  deviceInHand: requireDeviceInHand,
  deviceInHandRead: requireDeviceInHandRead
});

/** The item gate counts a slot by the rule the resolve settles it by (MICA-436). */
installSlotJudge({ known: usableNow, read: usableSlot });
