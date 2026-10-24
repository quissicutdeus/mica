// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { ALL_DEVICES, DEFAULT_DEVICE, DEVICES, type DeviceId } from '@mica/shared/devices';
import { Database } from '../lib/Database';
import { defineService, SchemaRepository } from '../lib/defineService';
import { PlayerFacingError } from '../lib/errors';
import { detectFramework, FrameworkBridge } from '../lib/FrameworkBridge';
import type { FrameworkPlayer } from '../lib/framework/runtime';
import { installDeviceResolvers, type RequestDeviceOptions } from '../lib/deviceIdentity';
import {
  deviceItemName,
  holdsDevice,
  isDeviceEnabled,
  onDeviceStateChanged
} from '../lib/deviceItem';
import { characterExists } from '../lib/orphanSweep';
import { onCharacterDeleted } from '../lib/shell';
import { traceOf } from '../lib/sqlErrors';
import { who } from '../lib/who';

/**
 * The phone as a thing with an identity of its own (MICA-280), and the thing every device-owned
 * row belongs to (MICA-282).
 *
 * **Why this is its own table rather than `mica_phone_numbers`.** The number table is what a
 * phone *has*; this is what a phone *is*. MICA-284 moved the number onto the phone, and
 * MICA-282 moved contacts, notes, media and the rest — every table declared `deviceOwned`
 * carries a `device_id` that points here.
 *
 * **A character has exactly one phone and one tablet** (MICA-438): one row of each kind, which
 * is theirs until the character is deleted, when it is erased with them (MICA-440). The phone
 * item is a key, not a phone. Holding any copy of it opens *your*
 * phone, with everything on it, number included; somebody else's copy in your hand opens yours
 * too, never theirs; and a stolen phone's owner who buys a new one has everything back, as if
 * restored from a backup. So nothing here reads or writes an inventory item: a device is its
 * citizen's row of that kind (`identityDevice`), created the first time they need one, and the
 * item only says whether they hold a device at all, by count, on a server that gates on it
 * (`lib/deviceItem.ts`). There are no burners and no handovers: one keybind, one phone.
 *
 * MICA-219 to MICA-436 minted an id into each item instead, so a character could hold several
 * phones and a phone could change hands. That rested on item metadata, which any resource can
 * write and the commonest FiveM duplication exploit copies, and it never ran in game. What it
 * left behind is a few rows per citizen on a development database; the newest one — last
 * created or claimed, since nothing touches a row on use — is their device now, and the others
 * are kept as they are.
 *
 * **A tablet is a row here too** (MICA-264), told apart by `kind`. It has an identity of its
 * own — notes, settings and a lock screen of its own, keyed on its own id — but none of a
 * phone's reach: every lookup that means "the citizen's phone" (`phoneForCitizen`,
 * `identityPhone`) reads `kind = 'phone'` only, so an offline call log or a notification never
 * lands on a tablet, and a tablet never gets a number.
 *
 * **Nothing here is reachable from a client.** Every generic action is off, so this
 * declaration registers no net event at all — a device id is minted by the server and is never
 * something a payload sets, chooses or deletes (§2.9).
 */
export interface DeviceRow {
  id: number;
  citizenid: string;
  device_id: string;
  /** Which device this is (MICA-264). Fixed when the row is minted; nothing changes it. */
  kind: DeviceId;
  /** Unused since MICA-438: read by nothing, and left at its default by every insert. */
  claimed?: number | boolean;
  /**
   * `1` from the insert until every new-device hook has finished (MICA-335). Absent on a row
   * read before `micaschema apply` added the column, which reads as finished.
   */
  setup_pending?: number | boolean;
  status: string;
  updated_at?: Date | string;
}

/**
 * The devices table's repository, with the two statements the generic path has no shape for: a
 * citizen's rows of one kind, newest first, and marking a device's set-up finished.
 * Server-internal — nothing reaching either comes from a payload; the citizenid is the one the
 * framework connection names, and the device id one this server minted or read back.
 */
class DeviceRepository extends SchemaRepository<DeviceRow> {
  /**
   * Every live row of this kind for this citizen, the one `identityDevice` takes first. One row
   * on any database since MICA-438; several only where an earlier build minted them. The
   * `citizenid_status` key narrows the read to that handful before `kind` is looked at.
   */
  async identityRows(citizenid: string, kind: DeviceId): Promise<DeviceRow[]> {
    // `*`, never a column list: a database `micaschema apply` has not given `setup_pending` yet
    // (MICA-335) must still answer, its rows reading as set up, as `DeviceRow` says they do.
    return await Database.query<DeviceRow[]>(
      `SELECT * FROM \`${this.tableName}\` ` +
        "WHERE `citizenid` = ? AND `kind` = ? AND `status` = 'active' " +
        'ORDER BY `updated_at` DESC, `id` DESC',
      [citizenid, kind]
    );
  }

  /**
   * Clear `setup_pending`. `updated_at` is pinned: `identityRows` reads it as "the citizen's
   * newest device", and finishing a set-up must not make a row newer than another.
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
     * Opaque rather than the row's own `id`. MICA-219 to MICA-436 wrote it into item metadata,
     * where any resource sharing the inventory could read it, and a sequential integer there
     * would have let somebody enumerate every phone by counting. Nothing writes it anywhere
     * outside this database since MICA-438, but it keys every device-owned row and every value
     * sealed to a device (MICA-431), so it stays the shape every existing row already has. It
     * is **not** a secret and nothing treats it as one: every predicate names the citizen too.
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
     * **Unused since MICA-438**, and kept only because dropping it would be a schema change
     * for nothing. It was `0` until a phone was written into an inventory item and `1` from
     * then on, so the first item a citizen used could adopt the phone the
     * `0002_phone_data_follows_the_phone` backfill left them. Nothing writes an item now, so
     * nothing is claimed: every insert leaves it at its default, and no read names it.
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
     * has no value at all, which reads as finished too. A `tinyint` rather than a nullable
     * timestamp because MariaDB's implicit `NOT NULL` on `timestamp` makes `DEFAULT NULL` a
     * per-server question, and this needs one answer.
     */
    setup_pending: { type: 'bool', notNull: true, default: 0, clientWritable: false }
  },
  indexes: [
    // Uniqueness is the schema's job. Two devices sharing an id would be two players sharing
    // one, since MICA-282 keys rows on it.
    // Not unique on (citizenid, kind), although MICA-438 gives a character one of each: a
    // database an earlier build ran on can hold several, which such a key would refuse to
    // `micaschema apply`, and `identityDevice` takes the newest of them. One process
    // creating a citizen's row joins any create already in flight for them, so it never makes
    // two. `defineService` already emits a `citizenid_status` key, and the identity read uses
    // its leading column, so no separate one is declared here.
    { name: 'device_id_unique', columns: ['device_id'], unique: true }
  ],
  uniqueAfterDelete: {
    optOut:
      'A device id is minted once and never reused. The erased row of a deleted character keeps ' +
      'its id under the key (MICA-440), and nothing creates a row with that id again.'
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

const newDeviceId = (): string => randomBytes(16).toString('hex');

/** One map per device kind (MICA-264): a phone and a tablet are two answers, never one. */
const byKind = <K, V>(): Record<DeviceId, Map<K, V>> =>
  Object.fromEntries(ALL_DEVICES.map((kind) => [kind, new Map<K, V>()])) as Record<
    DeviceId,
    Map<K, V>
  >;

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
/**
 * Each citizen's device of each kind, once found or created. A row's citizenid and kind never
 * change and nothing else creates a row for them, so an entry is invalidated only when the
 * character is deleted (MICA-440, `forgetDeletedCitizen`).
 */
const identityByCitizen = byKind<string, string>();
/** A citizen's identity read or create still in flight, which every concurrent ask joins. */
const pendingIdentity = byKind<string, Promise<string>>();
/** Citizens already reported as holding several rows of a kind: once each per process. */
const reportedSeveral = new Set<string>();
/**
 * Deleted characters whose purge is still running (MICA-440), each with the promise that settles
 * once it has finished. An identity ask for one waits for it before reading, so it never reads,
 * caches or answers a row the purge is about to erase. Each entry goes when its purge settles.
 */
const purging = new Map<string, Promise<void>>();
/**
 * How many characters have been forgotten (MICA-440). A read in flight when one is forgotten
 * caches nothing, since it may have read a row the purge erases after it: its own callers get
 * what it read, and the next ask reads again. Counted for everyone rather than per citizen, so
 * nothing is kept per deleted character; the cost is one extra read for an ask that overlapped
 * any deletion.
 */
let forgotten = 0;

/**
 * Whoever sets a device up the first time it exists (MICA-234) — `Contacts.ts`, which seeds the
 * owner's default contacts. A hook is handed the new row's `kind` (MICA-264) and decides for
 * itself what a tablet gets; the default contacts are a phone's, so a tablet gets none.
 * Registered here rather than imported: this file must not import the services that key on it.
 *
 * "New" means this server just inserted the device's `mica_devices` row, which happens once per
 * citizen and kind for as long as the character lives: only a deleted character's row is erased
 * (MICA-440), and the rows `0002_phone_data_follows_the_phone` backfilled were inserted by SQL,
 * not here, so an existing player's phone is never treated as new. That once-only insert is the
 * mark — a player who deletes a seeded contact is never re-seeded, because nothing re-creates
 * the phone. A new ESX character in a deleted one's slot gets a new phone, seeded as new.
 *
 * Hooks run **after** the device is answered, not inside the request that created it: a new
 * phone's first request should not wait on an owner's contact list. So a hook's work may land
 * a moment after the phone does, and nothing may depend on it having finished.
 *
 * **A hook that throws is run again** (MICA-327), on a later resolve of the same device, until
 * it succeeds — so it must be idempotent: a second run finishes what the first left and adds
 * nothing the first already wrote. The row's existence cannot be the mark that a hook
 * *finished*, only that the device is new, because it is inserted before any hook runs; its
 * `setup_pending` column is that mark (MICA-335), so a restart between a failure and its retry
 * runs **every** hook again on the device's first resolve after the start — the ones that had
 * already succeeded included, since nothing durable says which those were. Every run is handed
 * the device's owner, the citizen it was created for.
 *
 * Hooks run one after another on the device's queue (`queueOnDevice`), so a hook should not
 * await work it queues there itself. It is handed the device id and the owner, so it has
 * nothing to resolve.
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
 * New-device hooks that threw, by device, and when to try them again (MICA-327). The in-process
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
 * Run these hooks for this device, each its own failure, and remember any that threw. Never
 * rejects. Only ever run from the device's queue (`queueOnDevice`), so it cannot overlap
 * another run for it, which is what keeps an idempotent hook from doubling. `citizenid` is the
 * device's owner.
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
 * when the row was marked finished. Called where `identityDevice` reads the row anyway, once
 * per citizen and kind per process, so it costs no query of its own.
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
 * The device row was just inserted: queue every hook behind whatever the device is doing. Owed
 * from this moment rather than from the first failure, so a read of the row while the first
 * run is still queued — `setup_pending` is set — is not taken for one a restart left behind
 * (`resumeSetup`); `retryAt` is `Infinity` because the run is already queued.
 */
const announceCreated = (deviceId: string, citizenid: string, kind: DeviceId): void => {
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
 * Retry whatever a new device's hooks left, if anything, without holding up the resolve that
 * calls it: queued, not awaited, so the **next** set-up run for the device waits behind it
 * instead. One map lookup when nothing is owed, which is every device but a new one whose hooks
 * have not all finished — in this process, or in one before it (`resumeSetup`); backed off
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
 * How long to wait before running a new device's set-up again, by how many attempts in a row
 * have failed (MICA-327). The first retry is the next resolve — most failures are a dropped
 * connection or a lock wait, gone a moment later — and a hook that keeps failing settles at
 * one attempt, and one log line, every ten minutes rather than one per request.
 */
const RETRY_AFTER_MS = [0, 5_000, 30_000, 120_000, 600_000];
const retryDelay = (failures: number): number =>
  RETRY_AFTER_MS[Math.min(failures, RETRY_AFTER_MS.length) - 1];

/**
 * The set-up runs queued for each device (MICA-319, MICA-327), which the next one for that
 * device waits behind: two runs for one device would otherwise overlap and double an
 * idempotent hook's rows. An entry is deleted when the last run chained onto it settles, so
 * this holds only devices with a run in flight. No resolve waits here: a resolve answers from
 * the citizen's row, which a hook never changes.
 */
const settling = new Map<string, Promise<void>>();

/** Run `work` for this device once everything already queued for it has settled. */
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
  settling.clear();
  owedSetup.clear();
  reportedSeveral.clear();
  purging.clear();
  unreadableReported = false;
  for (const kind of ALL_DEVICES) {
    activeBySource[kind].clear();
    identityByCitizen[kind].clear();
    pendingIdentity[kind].clear();
  }
};

/**
 * The phone a connected source last resolved to, or null before its first resolve.
 *
 * Synchronous by design and therefore a cache, not a lookup: it answers what the last
 * `resolvePhone`/`deviceForRequest` for this source found. Every device-owned request
 * refreshes it, and so does the sync `deviceItem.ts` fires on load, use and inventory change,
 * so it is stale for at most the gap between picking a phone up or putting it down and the
 * server hearing about it.
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

/**
 * Forget a deleted character's devices (MICA-440), as the character-deleted hook runs: the
 * device each kind was cached as, any read in flight (`forgotten`), the once-per-process note,
 * the set-up still owed to it, and every source last resolved to one of them, so neither
 * `LockState` nor the battery keys a device that is about to be erased. Until `purged` settles,
 * an ask for them waits (`purging`); then it reads, finds no live row, and creates a device.
 */
const forgetDeletedCitizen = (citizenid: string, purged: Promise<void>): void => {
  forgotten += 1;
  for (const kind of ALL_DEVICES) {
    const known = identityByCitizen[kind].get(citizenid);
    if (known !== undefined) owedSetup.delete(known);
    identityByCitizen[kind].delete(citizenid);
    pendingIdentity[kind].delete(citizenid);
    reportedSeveral.delete(`${kind}:${citizenid}`);
    for (const [src, entry] of activeBySource[kind]) {
      if (entry.citizenid === citizenid) activeBySource[kind].delete(src);
    }
  }
  purging.set(citizenid, purged);
  void purged.then(() => {
    if (purging.get(citizenid) === purged) purging.delete(citizenid);
  });
};

onCharacterDeleted('devices', forgetDeletedCitizen);

/** The device a player is on: their own, of the kind asked for. */
export interface ActiveDevice {
  deviceId: string;
}

/**
 * Say once per process that a citizen has several rows of a kind (MICA-438), by token, with
 * the one taken. Only a database an earlier build ran on has any; nothing merges them, and
 * the others are left as they are.
 */
const reportSeveral = (citizenid: string, kind: DeviceId, taken: string, count: number): void => {
  const key = `${kind}:${citizenid}`;
  if (reportedSeveral.has(key)) return;
  reportedSeveral.add(key);
  console.warn(
    `[mica] ${who(citizenid)} has ${count} ${kind} rows from before a character had one ` +
      `${kind}; using ${who(taken)}, the newest. The others are left as they are.`
  );
};

/**
 * Whether a device may be created for this citizen (MICA-440). `vouched` says the caller holds
 * the loaded player it is for; everyone else is a row written on an offline citizen's behalf —
 * an export naming them, a notification, a call logged against them.
 *
 * **Never for a character the framework says does not exist.** After the character-deleted
 * purge, an export still naming the deleted identifier created a live phone and wrote to it, and
 * on ESX the next character created in the slot inherited it; on qb it was a junk phone until
 * the next sweep. So, in order:
 *
 * - **A loaded character is not asked about**: vouched for, or on a source the bridge knows
 *   (the integration door's players too). A character created a moment ago may not have their
 *   framework row yet, and must not be refused their first phone.
 * - **Standalone and the boot window are not asked about**: standalone keeps no character table,
 *   and before a framework answers there is nothing to read one by. Created as before; the
 *   sweep, which refuses in that window too, judges the phone later.
 * - **Otherwise the sweep's own owner table is read** (`characterExists`), under the verdict
 *   the sweep acts on, and a character not in it is refused: nothing is written, and the
 *   caller's write fails as one would.
 * - **A verdict the sweep would not act on creates, and says so once**: an owner table that
 *   cannot be read, a `mica_orphan_owner_table` that does not verify, or one naming none of
 *   micaOS's owners. Refusing would drop every offline write for every character without a
 *   phone yet — a notification, a contact, a call log — over a fault that has nothing to do
 *   with them. Creating costs only what this check prevents, for a deleted character named
 *   meanwhile, and the next sweep that runs erases an orphan's phone.
 *
 * **One race stays accepted:** a create already past this check when the character is deleted,
 * whose insert lands after the purge has erased the phone table, leaves them a live phone. It is
 * cached nowhere (`forgotten`); the next sweep erases it, and an ESX character created in the
 * slot before then is given it, holding whatever that write put there.
 */
const mayCreateFor = async (citizenid: string, vouched: boolean): Promise<boolean> => {
  if (vouched) return true;
  try {
    if (FrameworkBridge.getSourceByCitizenId(citizenid) !== null) return true;
    const framework = detectFramework();
    if (framework === 'standalone' || framework === 'unknown') return true;
    // `null` is a server with nothing to judge yet (no characters, no micaOS rows): create.
    return (await characterExists(citizenid)) ?? true;
  } catch (error) {
    reportUnreadable(error);
  }
  return true;
};

/** Whether `mayCreateFor` has said it could not ask. Once per process, like its sweep's line. */
let unreadableReported = false;
const reportUnreadable = (error: unknown): void => {
  if (unreadableReported) return;
  unreadableReported = true;
  console.error(
    '[mica] could not tell whether a character exists before creating a phone on their ' +
      'behalf, so phones are created without asking until it can: one may be made for a ' +
      'deleted character (MICA-440). Said once per resource start.',
    traceOf(error)
  );
};

/**
 * What a write on behalf of a character who does not exist is refused with (MICA-440). Its own
 * class so an export can answer it as the `unknown_player` it is (`lib/publicApi.ts`), rather
 * than as a failure of micaOS's.
 */
export class NoSuchCharacterError extends Error {
  constructor(citizenid: string, kind: DeviceId) {
    super(
      `no character ${who(citizenid)} exists here, so no ${kind} is created for them and ` +
        'nothing is written to one (MICA-440).'
    );
    this.name = 'NoSuchCharacterError';
  }
}

/** Read the citizen's device of this kind, or create it. `identityDevice` joins concurrent asks. */
const findIdentity = async (
  citizenid: string,
  kind: DeviceId,
  vouched: boolean
): Promise<string> => {
  const before = forgotten;
  // Cached only if no character was forgotten meanwhile (`forgotten`).
  const remember = (deviceId: string): void => {
    if (forgotten === before) identityByCitizen[kind].set(citizenid, deviceId);
  };
  const rows = await repo.identityRows(citizenid, kind);
  const [newest] = rows;
  if (newest) {
    if (rows.length > 1) reportSeveral(citizenid, kind, newest.device_id, rows.length);
    remember(newest.device_id);
    resumeSetup(newest.device_id, newest, kind);
    finishSetup(newest.device_id, citizenid);
    return newest.device_id;
  }
  if (!(await mayCreateFor(citizenid, vouched))) throw new NoSuchCharacterError(citizenid, kind);
  const deviceId = newDeviceId();
  await repo.create({
    citizenid,
    device_id: deviceId,
    kind,
    setup_pending: 1
  } as Partial<DeviceRow>);
  remember(deviceId);
  announceCreated(deviceId, citizenid, kind);
  return deviceId;
};

/**
 * A citizen's device of this kind (MICA-438): their row of that kind, created the first time
 * they need one. Several rows are an earlier build's (dev data): the newest wins — `updated_at`
 * latest, then the highest `id` — said once per citizen, and the rest are kept. Newest, not most
 * recently used: nothing writes a device row on use, and `markSetupFinished` pins `updated_at`,
 * so a row is as new as its create, or the claim an earlier build wrote.
 *
 * Read once per citizen and kind per process, then cached: a row's owner and kind never change,
 * and nothing else creates one. Asks that arrive while the read or the create is in flight join
 * it, so one process never creates two rows for one citizen. A failed read or create rejects,
 * caches nothing, and the next ask tries again.
 *
 * **A deleted character is read again** (MICA-440): their entries go when the character-deleted
 * hook runs (`forgetDeletedCitizen`), and an ask while their purge is still running waits for it
 * before reading. So a new ESX character in the slot, under the same identifier, finds the old
 * phone erased and gets a new one, as a first resolve does.
 *
 * **And nobody is created a phone who does not exist** (`mayCreateFor`): a refusal rejects,
 * caches nothing, and is asked again next time, so a character created later is not refused.
 */
const identityDevice = (citizenid: string, kind: DeviceId, vouched = false): Promise<string> => {
  const known = identityByCitizen[kind].get(citizenid);
  if (known) {
    finishSetup(known, citizenid);
    return Promise.resolve(known);
  }
  const pending = pendingIdentity[kind].get(citizenid);
  if (pending) return pending;
  const purge = purging.get(citizenid);
  const lookup = purge
    ? purge.then(() => findIdentity(citizenid, kind, vouched))
    : findIdentity(citizenid, kind, vouched);
  pendingIdentity[kind].set(citizenid, lookup);
  const forget = (): void => {
    if (pendingIdentity[kind].get(citizenid) === lookup) pendingIdentity[kind].delete(citizenid);
  };
  void lookup.then(forget, forget);
  return lookup;
};

/**
 * The citizen's phone — `identityDevice` for the phone, never a tablet. `loaded` is for a caller
 * holding the loaded player it asks for, which is never refused a create (`mayCreateFor`).
 */
export const identityPhone = (
  citizenid: string,
  options: { loaded?: boolean } = {}
): Promise<string> => identityDevice(citizenid, 'phone', options.loaded === true);

/**
 * The phone a citizen is on, for a row written on their behalf — a notification, a photo
 * dropped onto them, a contact a job hands them, a call logged against them. Always a phone,
 * never a tablet (MICA-264).
 *
 * Their phone, online or not, held or not (MICA-438): a character has one, so it is the phone
 * every device-owned request of theirs resolves to as well. What lands while they hold none
 * waits on it for them, as it would in a stash (MICA-339's decision), and a thief holding their
 * item never sees it — the thief's own resolve answers the thief's own phone.
 *
 * A citizen who does not exist has no phone: this rejects with `NoSuchCharacterError` rather
 * than create one (MICA-440, `mayCreateFor`), and the caller's write fails — a notification is
 * dropped and logged, and `AddMedia` and `AddContact` answer `unknown_player`.
 */
export const phoneForCitizen = (citizenid: string): Promise<string> => identityPhone(citizenid);

/**
 * What resolving a source's device can come to, and why three answers rather than a nullable.
 *
 * The number sync (MICA-284) and the request resolver (MICA-282) have to tell two of them apart:
 * a player on a gated server who holds **no** phone must be refused — they have no phone in
 * hand, and it is closed for them anyway — while a server that requires no item at all
 * answers the citizen's phone without one. `'unavailable'` is that second case, and a source
 * with no loaded character.
 */
export type DeviceResolution =
  | { status: 'active'; device: ActiveDevice }
  /** An item of this device is required here and this player holds none. */
  | { status: 'none' }
  /** No item is required here (or nobody is loaded on the source), so nothing was counted. */
  | { status: 'unavailable' };

const UNAVAILABLE: DeviceResolution = { status: 'unavailable' };
const NONE: DeviceResolution = { status: 'none' };

/**
 * Record a device as the one this source is on now — unless the source is no longer this
 * citizen. A resolve that read the row cold (`cold`) yielded to the host meanwhile, and two
 * things can have landed in that gap. A character switch keeps the source
 * (`forgetOnPlayerLoaded`), so writing would put the previous character's device over the new
 * one's entry. A disconnect clears the source's entries on `playerDropped`, so writing would put
 * one back for a server id FiveM hands to the next player, who would inherit the old phone's
 * lock and battery key until their first resolve. Either way `LockState` and the battery would
 * key the wrong device, so nothing is written unless this citizen is still on the source. A warm
 * resolve awaited only a settled promise, which no host event can land inside, so it asks
 * nothing: MICA-362's one player lookup per request holds. The answer itself is still the
 * request's to use either way: it is the device of the citizen it came from.
 */
const markActive = (
  src: number,
  citizenid: string,
  kind: DeviceId,
  deviceId: string,
  cold: boolean
): void => {
  if (cold) {
    const now = FrameworkBridge.getPlayer(src);
    if (!now || now.citizenid !== citizenid) return;
  }
  activeBySource[kind].set(src, { deviceId, citizenid });
};

/** Whether resolving this citizen's device of this kind will have to read it (`markActive`). */
const isCold = (citizenid: string, kind: DeviceId): boolean =>
  !identityByCitizen[kind].has(citizenid);

/**
 * Drop the device of this kind a source was last on, when a resolve finds it is no longer
 * theirs (MICA-264) — unless it was resolved for `keep`, the character the source has now.
 *
 * A resolve that answers `'none'` passes no `keep`: they hold none, so `LockPhone` must not key
 * the device they put down. One that answers `'unavailable'` passes the current character: on
 * a server with no item gate that answer is the steady state, and the device `deviceForRequest`
 * cached for this same character is still right, but one cached for the previous character
 * after a switch is not.
 */
const forgetActive = (src: number, kind: DeviceId, keep?: string): void => {
  const entry = activeBySource[kind].get(src);
  if (entry && entry.citizenid !== keep) activeBySource[kind].delete(src);
};

/**
 * The device of this kind this source is using: the character's own, while they hold an item
 * of it (MICA-438).
 *
 * **The rule lives here and nowhere else**, so no service re-implements it. On a server that
 * gates the device on an item, the item is counted (`holdsDevice`): none held is `'none'`, and
 * any held is the citizen's device of that kind — whichever copy it is, whatever it carries,
 * and whoever it was bought by. Nothing is read from the item and nothing is written to it.
 * Where the inventory cannot count, the gate fails open as it always has. With no gate, or no
 * loaded character, the answer is `'unavailable'`, and `deviceForRequest` answers the citizen's
 * device without a count.
 *
 * **A resolve that finds no device of this kind clears the cached one** (`forgetActive`), so
 * the synchronous answer `LockState` keys on never outlives the item in hand.
 *
 * `player` is the one the caller already looked up for this source (MICA-362), so a request
 * does not walk the framework's player table twice; absent, it is looked up here.
 */
export const resolveDevice = async (
  src: number,
  kind: DeviceId,
  given?: FrameworkPlayer
): Promise<DeviceResolution> => {
  // An off device has no item to hold. `ServiceEndpoint` refuses its requests before this.
  if (!isDeviceEnabled(kind)) {
    forgetActive(src, kind);
    return NONE;
  }
  const player = given ?? FrameworkBridge.getPlayer(src);
  if (!deviceItemName(kind) || !player?.citizenid) {
    forgetActive(src, kind, player?.citizenid);
    return UNAVAILABLE;
  }
  if (!holdsDevice(player, kind)) {
    forgetActive(src, kind);
    return NONE;
  }
  const cold = isCold(player.citizenid, kind);
  const deviceId = await identityDevice(player.citizenid, kind, true);
  markActive(src, player.citizenid, kind, deviceId, cold);
  return { status: 'active', device: { deviceId } };
};

/**
 * The phone this source is using: `resolveDevice` for the phone. Kept as its own name because
 * the number sync (`PhoneNumbers.ts`) and `GetPhoneNumber` are the phone's alone, and a tablet
 * must never reach either.
 */
export const resolvePhone = (src: number): Promise<DeviceResolution> => resolveDevice(src, 'phone');

/**
 * The phone this source is using, or `null` when they hold none or the server requires no item.
 *
 * `resolvePhone` with its three answers folded to one, for a caller that does not need to
 * tell "holds none" from "nothing to count".
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
 * have no device in hand, and it is closed for them anyway (`deviceItem.ts`), so the only way
 * this is reached is a client that opened it regardless. With no gate, the citizen's device.
 *
 * **`requireHeld` makes it `requireDeviceInHand` too** (MICA-362), from the same count: a
 * request that is both a claim to hold the device and scoped by it asks the inventory once. An
 * off device is refused first, with the same `server.device.off` toast, and a request with no
 * player to count is refused rather than waved through. Nothing is kept: the next request
 * counts again, because that count is the proof the device is still in hand after a robbery.
 */
export const deviceForRequest = async (
  src: number,
  citizenid: string,
  device: DeviceId = DEFAULT_DEVICE,
  options: RequestDeviceOptions = {}
): Promise<string> => {
  if (options.requireHeld && !isDeviceEnabled(device)) throw turnedOff(device);
  const player = options.player ?? FrameworkBridge.getPlayer(src);
  const resolution = await resolveDevice(src, device, player ?? undefined);
  if (resolution.status === 'active') return resolution.device.deviceId;
  if (resolution.status === 'none') throw notHeld(device);
  // Unavailable: no gate here, or nobody loaded on the source to count for.
  if (options.requireHeld && !player) throw notHeld(device);
  const cold = isCold(citizenid, device);
  // Vouched for only by a player on the source who is this citizen (`mayCreateFor`).
  const identity = await identityDevice(citizenid, device, player?.citizenid === citizenid);
  // Nobody on the source, nothing to record: an entry for an empty source is one a reused
  // server id would inherit (`markActive`). Nothing reads one for a source with no player.
  if (player) markActive(src, citizenid, device, identity, cold);
  return identity;
};

/**
 * Refuse a request that names a device this server has off, or one the player holds none of
 * (MICA-264) — for every service, device-owned or not, since a request from the tablet is
 * a claim to be holding one. Counted now, through the same `holdsDevice` the item gate uses,
 * so it fails open exactly where that does: no gate configured, standalone, or an inventory
 * that cannot count. Synchronous, so the call-answer path can ask it without yielding.
 */
export const requireDeviceInHand = (player: FrameworkPlayer, device: DeviceId): void => {
  if (!isDeviceEnabled(device)) throw turnedOff(device);
  if (!holdsDevice(player, device)) throw notHeld(device);
};

/**
 * Re-resolve a non-phone device whenever `deviceItem.ts` says it may have changed (MICA-264):
 * a load, a relayed inventory change, a use of its item. The phone's own subscribers (the
 * number sync, the battery) already resolve the phone on those occasions, which refreshes or
 * clears its entry the same way; this gives the tablet the same, so `LockPhone(src, 'tablet')`
 * after the tablet is put down, taken, or a character switch keys what is in hand, not what a
 * device-owned request happened to resolve last. Nothing is created for a tablet nobody holds:
 * a resolve that finds none clears the entry and writes nothing.
 */
onDeviceStateChanged('device-identity', (src, device) => resolveDevice(src, device));

installDeviceResolvers({
  forRequest: deviceForRequest,
  forCitizen: phoneForCitizen,
  deviceInHand: requireDeviceInHand
});
