// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import { detectFramework, FrameworkBridge, type FrameworkPlayer } from '../lib/FrameworkBridge';
import { onPhoneStateChanged } from '../lib/deviceItem';
import {
  ACTIVE_STATUS,
  generatePhoneNumber,
  MAX_ASSIGN_ATTEMPTS,
  PHONE_NUMBERS_TABLE,
  readLegacyRow,
  readRowByPhoneId,
  rememberNumber,
  type AssignedNumberRow,
  type PhoneNumberRow
} from '../lib/phoneNumbers';
import { PhoneNumberRepository } from '../repositories/PhoneNumberRepository';
import { isDuplicateKey, traceOf } from '../lib/sqlErrors';
import { identityPhone, resolvePhone, type ActiveDevice } from './Devices';
import { who } from '../lib/who';

/**
 * The one table micaOS owns a phone number in (MICA-151), and the phone each number belongs
 * to (MICA-284).
 *
 * **The decision this table represents, stated rather than implied.** A phone number belongs
 * to the **phone**, not to the character holding it. micaOS is the source of truth for
 * numbers on standalone and on both qb cores, and the active phone's number is written back
 * into the framework's own field — `charinfo.phone`, through `SetCharInfo` on qbx_core or
 * `SetPlayerData` on qb-core — so that `GetPlayerByPhone`, the dispatch script and the job
 * script that texts you all keep reading a number that is still right. That write-back is the
 * whole reason owning numbers on a framework is now defensible: MICA-151 refused it because a
 * micaOS number sitting *beside* the framework's would be one only the phone believed, and it
 * was right. The mirror is what makes them one number.
 *
 * **ESX keeps the number on the character.** There is no standard setter for an ESX phone
 * number — the community resources that add one disagree about the field, let alone the
 * call — so there is nothing to write back through, and inventing a write into a table micaOS
 * does not own is the mistake §10 forbids. On es_extended micaOS keeps reading whatever the
 * operator's resource provides, issues nothing, and says so once at start. A number there is
 * the character's, not the phone's, which is honest about what the framework allows.
 *
 * **A number attaches to a phone lazily.** The migration that shipped with MICA-284 gave every
 * existing qb character a **legacy row** — their current number, `device_id` NULL — and the
 * first sync of their phone attaches that row to it, on a server that gates on a phone item or
 * not (MICA-439). Nobody's number changes on upgrade. A character has exactly one phone
 * (MICA-438), so that is one number per character, kept with the phone: through a gate turned
 * on or off, and for a stolen phone's owner who picks up a new item.
 *
 * **Nothing here is reachable from a client.** `write: 'server'` turns off the generic create
 * and update, and `disableGet`/`disableDelete` turn off the other two, so this declaration
 * registers no net event at all — a number is assigned by the server and is never something a
 * payload gets to set, choose or delete (§2.9, and `reachability.test.ts` keeps the registered
 * set deliberate). The privileged write it does need is a named method on
 * `PhoneNumberRepository`, which is where §2.9 says it goes.
 */
export const phoneNumbers = defineService<PhoneNumberRow>({
  id: 'phonenumbers',
  table: PHONE_NUMBERS_TABLE,
  access: { read: 'owner', write: 'server' },
  schema: {
    /**
     * 16 characters rather than the 7 a generated number occupies. `netGuard.phoneNumberFrom`
     * accepts up to 32 off the wire, and a number adopted from a qb `charinfo` carries whatever
     * shape qb gave it — the column should not be the thing that refuses it.
     */
    number: { type: 'string', length: 16, notNull: true, clientWritable: false },
    /**
     * The phone this number is on: a `mica_devices.device_id`, or NULL for a legacy row that is
     * a citizen's number not yet attached to any phone. Nullable on purpose — see the
     * declaration note — and deliberately **not a foreign key** onto `mica_devices`: the
     * additive half of `micaschema apply` adds columns and keys and never a constraint, so a
     * foreign key here would hold on a fresh install and not on an upgraded one. A constraint
     * that is true on half the servers is a lie, and the resolver in `Devices.ts` is what keeps
     * the two tables in step instead.
     */
    device_id: { type: 'string', length: 32, clientWritable: false, versioned: true }
  },
  indexes: [
    /**
     * **Uniqueness is the schema's job, not the application's.** Both keys are what the
     * assignment loop trusts: it generates, inserts, and reads the violation, rather than
     * checking first and inserting second. A check-then-insert has a race between two players
     * connecting in the same tick that no amount of care in TypeScript closes, and a duplicate
     * number is not a cosmetic problem — two players would receive each other's messages.
     *
     * `number` unique: no two phones share a number. `device_id` unique: a phone has one number
     * — and NULL is exempt from a unique key, so any number of legacy rows coexist.
     *
     * **There is deliberately no unique key on `citizenid` any more.** MICA-151 had one, and
     * it was right while a number belonged to a character; a character who holds two phones
     * holds two numbers, so `0001_phone_numbers_follow_the_phone` drops it. The soft-delete
     * wedge that key's note used to describe — a `'deleted'` row occupying the citizen's slot
     * forever — is gone with it, but reactivating rather than reissuing is still the right
     * behaviour for a row that is a player's identity, and `claimRow` keeps doing it.
     */
    { name: 'number_unique', columns: ['number'], unique: true },
    { name: 'device_id_unique', columns: ['device_id'], unique: true }
  ],
  uniqueAfterDelete: {
    optOut:
      '`assign` reads the duplicate-key refusal as its signal — another number, or the row a ' +
      "concurrent sync won — and `claimRow` reactivates a 'deleted' row by hand."
  },
  options: { disableGet: true, disableDelete: true },
  repositoryFactory: (resolved) => new PhoneNumberRepository(resolved)
});

const repo = phoneNumbers.repo as PhoneNumberRepository;

/**
 * Numbers this process has already resolved for a phone, so a re-sync with nothing changed
 * costs no query. Keyed by phone id, with the citizen it was resolved for beside it, so a sync
 * for anybody else re-reads. Only the phone's owner ever resolves to it since MICA-438, so
 * that is a safety rather than something a sync relies on.
 */
const onPhone = new Map<string, { number: string; citizenid: string }>();

/**
 * One sync in flight per source and character. The phone-item relay and the usable-item
 * callback can fire within a tick of each other on a load, and two assignment loops for the
 * same citizen would happily issue two numbers now that nothing in the schema stops them.
 *
 * **Tagged with the citizen it was started for** (MICA-336). A multichar switch keeps the
 * source, so a sync still in flight for the previous character would otherwise be joined by
 * the next one's load and hand them the previous character's number, with nothing to re-sync
 * them after.
 *
 * **A trigger never joins a run already going; it queues one run behind it** (MICA-346). A run
 * counts the phone in hand the moment it starts, so a trigger that arrives once it has started
 * may be about a change it did not see: a phone picked up after a run that found none, which
 * would otherwise be left with no number until the next trigger. `again` is a fresh run that
 * starts when this one ends, and every trigger before it starts joins it, so a burst still
 * costs one run behind the one going. When nothing changed it is all cache: `onPhone` answers
 * and the write-back finds nothing to write.
 */
interface SyncRun {
  citizenid: string | null;
  run: Promise<string | null>;
  again: Promise<string | null> | null;
}
const syncing = new Map<number, SyncRun>();

const reported = new Set<string>();

const reportOnce = (key: string, message: string): void => {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(message);
};

/** Test seam: module state that would otherwise leak between cases. */
export const __resetPhoneNumberState = (): void => {
  onPhone.clear();
  syncing.clear();
  reported.clear();
};

/**
 * The number the framework itself currently has for this player, or null.
 *
 * Read off `rawPlayer` rather than `player.phone`, deliberately: the adapters fill `phone` from
 * micaOS's own cache first, and this is the one place that needs to know what the *framework*
 * believes — to adopt it on the first sync, and to decide whether a write-back is needed. Capped
 * at the column's width, because adopting a value the column cannot hold would not fail
 * loudly in a non-strict MySQL; it would truncate.
 */
const frameworkNumber = (player: FrameworkPlayer): string | null => {
  const raw = player.rawPlayer?.PlayerData?.charinfo?.phone;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text.length > 0 && text.length <= 16 ? text : null;
};

/**
 * Make a row of this citizen's live, whatever state it is in, and hand back its number.
 *
 * A row can be soft-deleted and still be the right one — `lib/retention.ts` never hard-deletes,
 * so a `'deleted'` row still holds the number and is reactivated rather than treated as an
 * obstacle. The reactivation is the ordinary ownership-scoped `update`, scoped by `citizenid`:
 * every caller hands over a row that names them — a legacy row read by their id, or the row on
 * their own phone once `numberForPhone` has detached one that named anybody else.
 *
 * A failed write is logged and the number is still returned. The phone is in this player's
 * hand either way, and refusing to tell them their number because a status column would not
 * move is a worse outcome than a stale status with a line in the log.
 */
const claimRow = async (row: AssignedNumberRow, citizenid: string): Promise<string> => {
  if (row.status !== ACTIVE_STATUS) {
    const reactivated = await repo.update(
      row.id,
      { status: ACTIVE_STATUS } as Partial<PhoneNumberRow>,
      citizenid
    );
    if (!reactivated) {
      console.error(
        `[mica] could not reactivate the soft-deleted phone number row for ${who(row.number)}. ` +
          `It is still ${who(citizenid)}'s — every read of ${PHONE_NUMBERS_TABLE} is status-blind ` +
          `on purpose — but the row is still marked '${row.status}'.`
      );
    }
  }

  return row.number;
};

const number = (row: AssignedNumberRow): string => `number ${row.number}`;

/**
 * Issue a number: the one the framework already had, if it can be taken, else a fresh one.
 *
 * Three things have to be true at once, and the order below is what makes them so:
 *
 * - **Stable.** On qb a character already has a `charinfo.phone`, issued by qb at creation,
 *   and every contact anybody saved for them points at it. It is tried first, so an upgrade
 *   — or a fresh micaOS install on a server with years of characters — changes nobody's
 *   number. Only when it is genuinely taken by another phone does a fresh one get generated.
 * - **Unique.** Enforced by the unique key on `number`. This generates, attempts the insert,
 *   and reads the failure — it does not pre-check with a `SELECT`, which would leave a window
 *   between the check and the write.
 * - **Bounded.** `MAX_ASSIGN_ATTEMPTS` collisions in a row means the space is genuinely full
 *   rather than unlucky, and that is reported rather than retried forever or, far worse,
 *   papered over by handing out a number somebody already has.
 *
 * A duplicate can come from either key. A duplicate `number` is an ordinary collision:
 * generate another. A duplicate `device_id` means a concurrent sync already gave this phone a
 * number, and no new candidate will get past that — so the winner's row is claimed instead.
 *
 * Returns null on failure rather than throwing. The callers are subscribers to the phone-item
 * registry, which must not be able to fail a load; a player with no number has a phone that
 * cannot be dialled, which is worse than a phone and better than no connection.
 */
const assign = async (
  citizenid: string,
  deviceId: string,
  preferred: string | null
): Promise<string | null> => {
  const candidates = function* (): Generator<string> {
    if (preferred) yield preferred;
    for (let attempt = 0; attempt < MAX_ASSIGN_ATTEMPTS; attempt++) yield generatePhoneNumber();
  };

  for (const candidate of candidates()) {
    try {
      await repo.create({
        citizenid,
        number: candidate,
        device_id: deviceId
      } as Partial<PhoneNumberRow>);
      return candidate;
    } catch (error) {
      if (!isDuplicateKey(error)) {
        console.error(
          `[mica] could not assign a phone number to ${who(citizenid)}. They will have a phone ` +
            `that cannot be dialled until this is fixed; nothing else is affected. If the ` +
            `table is missing, import the schema for this server (${PHONE_NUMBERS_TABLE}).`,
          traceOf(error)
        );
        return null;
      }

      const winner = await readRowByPhoneId(deviceId);
      // A row on this phone naming somebody else is not theirs to take: nothing this sync,
      // and the next one's `numberForPhone` detaches it first.
      if (winner) return winner.citizenid === citizenid ? await claimRow(winner, citizenid) : null;

      if (candidate === preferred) {
        console.warn(
          `[mica] the framework's number ${preferred} for ${who(citizenid)} is already on another ` +
            `phone, so they are being issued a fresh one. It is written back into the ` +
            `framework, so other resources see the new number too.`
        );
      }
    }
  }

  console.error(
    `[mica] gave up assigning a phone number to ${who(citizenid)} after ${MAX_ASSIGN_ATTEMPTS} ` +
      `attempts, every one of which collided with a number already issued. That means the ` +
      `number space is close to exhausted rather than that this player was unlucky — see ` +
      `lib/phoneNumbers.ts, which sizes it. No number was issued and none was reused.`
  );
  return null;
};

/** What putting a legacy number on its phone came to: the number, and whether it is on the phone. */
interface Attached {
  number: string | null;
  /** False while the number is answered from the legacy row unattached: the next sync tries again. */
  settled: boolean;
}

/**
 * Put the citizen's legacy number onto their phone.
 *
 * The upgrade path, and the reason nobody's number changes: the migration left their number
 * as a legacy row, and their phone takes it on its first sync, gated or not (MICA-439). **No
 * version is written** (`attachToPhone`, MICA-438 review), so this works on a database
 * `micaschema apply` has not brought up to MICA-430 too.
 *
 * A duplicate here is a concurrent sync that gave this phone a number first, and its row is
 * claimed rather than fought over — if it is this citizen's. Any other failure, or an attach
 * that moved nothing because the row moved meanwhile, leaves the number theirs, unattached:
 * the legacy row is answered as it stands, nothing is issued in its place, and the phone is
 * left uncached so the next sync tries again. Said each time.
 */
const attachLegacy = async (
  legacy: AssignedNumberRow,
  deviceId: string,
  citizenid: string
): Promise<Attached> => {
  try {
    const attached = await repo.attachToPhone(legacy.id, deviceId, citizenid);
    if (!attached) {
      console.error(
        `[mica] ${who(number(legacy))} was already on a phone, or no longer ${who(citizenid)}'s ` +
          `legacy row, when their sync went to attach it — a concurrent sync, most likely. It ` +
          `is answered as read this sync, not cached, and the next sync reads the row again.`
      );
      return { number: await claimRow(legacy, citizenid), settled: false };
    }
  } catch (error) {
    if (isDuplicateKey(error)) {
      const winner = await readRowByPhoneId(deviceId);
      const theirs = winner !== null && winner.citizenid === citizenid;
      return { number: theirs ? await claimRow(winner, citizenid) : null, settled: theirs };
    }
    console.error(
      `[mica] could not attach ${who(number(legacy))} to a phone. It stays their number, ` +
        'unattached; the next sync tries again.',
      traceOf(error)
    );
    return { number: await claimRow(legacy, citizenid), settled: false };
  }
  return { number: await claimRow(legacy, citizenid), settled: true };
};

/**
 * Take a number row that names somebody else off this citizen's phone (MICA-438 review). Only a
 * handover before MICA-436 could leave one, and only where that handover actually ran, which no
 * live server did (the owner confirmed it for production).
 *
 * **The row cannot tell which character should have had the number.** Numbers followed the
 * phone then, so in the common case it was the phone owner's and the handover left it naming the
 * last holder; in the rare reverse case it was the named character's all along. So nothing is
 * adopted across characters by code: the number stays with the character the row names, as
 * their legacy number, which their own phone takes on their next sync; and this phone's owner
 * goes on to their own legacy row, or a fresh number. In the common case that hands the owner's
 * old number to the last holder — the price of never guessing. Said once per row, by token.
 */
const detachForeign = async (
  row: AssignedNumberRow,
  deviceId: string,
  owner: string
): Promise<boolean> => {
  const detached = await repo.detachForeign(row.id, deviceId, owner);
  reportOnce(
    `detached:${row.id}`,
    `[mica] ${who(number(row))} was on ${who(owner)}'s phone ${who(deviceId)} but named ` +
      `${who(row.citizenid)}, a row a handover left before MICA-436. ` +
      (detached
        ? `Detached: it is ${who(row.citizenid)}'s number again, on their own phone's next sync.`
        : 'It moved before it could be detached; the next sync reads it again.')
  );
  return detached;
};

/**
 * The number on a phone, for the citizen holding it.
 *
 * In order: the number already on this phone (`claimRow`) — detached first if it names
 * somebody else (`detachForeign`); the citizen's legacy number, attached to the phone; and
 * finally a fresh assignment, preferring the framework's own value.
 * That order is what keeps a character's number through the upgrade that introduced phones,
 * and through a robbery: the phone is the citizen's own whichever item they hold (MICA-438), so
 * a new item finds the number already on it.
 */
const numberForPhone = async (
  phone: ActiveDevice,
  citizenid: string,
  preferred: string | null
): Promise<string | null> => {
  const known = onPhone.get(phone.deviceId);
  if (known && known.citizenid === citizenid) return known.number;

  let resolved: string | null;
  // Cached only once the number is on the phone, so a legacy row an attach could not move yet
  // is tried again on the next sync rather than answered from here until a restart.
  let settled = true;
  let existing = await readRowByPhoneId(phone.deviceId);
  if (existing && existing.citizenid !== citizenid) {
    // A row naming somebody else: it stays theirs, off this phone, and the owner goes on to
    // their own (`detachForeign` has why nothing is adopted). If it moved meanwhile, nothing.
    if (!(await detachForeign(existing, phone.deviceId, citizenid))) return null;
    existing = null;
  }
  if (existing) {
    resolved = await claimRow(existing, citizenid);
  } else {
    const legacy = await readLegacyRow(citizenid);
    if (legacy) {
      const attached = await attachLegacy(legacy, phone.deviceId, citizenid);
      resolved = attached.number;
      settled = attached.settled;
    } else {
      resolved = await assign(citizenid, phone.deviceId, preferred);
    }
  }

  if (resolved && settled) onPhone.set(phone.deviceId, { number: resolved, citizenid });
  return resolved;
};

/**
 * Keep the framework in step with the number micaOS has decided on.
 *
 * Through the framework's own export — never a write into its table (§10). qbx_core's
 * `SetCharInfo` persists through `UpdatePlayerData` and is what its own `GetPlayerByPhone`
 * reads, so every other resource on the server follows along; qb-core has `SetPlayerData`.
 * Each adapter's `setPhone` knows which.
 *
 * Only when the values differ, so an ordinary load on a server where nothing has changed
 * writes nothing. And a player holding **no** phone never reaches here at all: `syncNumber`
 * returns before this on `'none'`, leaving the framework's last value alone. A blank
 * `charinfo.phone` breaks every other resource that reads one, where a stale one merely fails
 * to reach somebody who has no phone to be reached on anyway.
 */
const writeBack = (player: FrameworkPlayer, value: string): void => {
  if (frameworkNumber(player) === value) return;

  if (typeof player.setPhone !== 'function') {
    reportOnce(
      'no-setter',
      `[mica] micaOS owns the phone numbers on this server but the framework offers no way ` +
        `to write one back (qbx_core's SetCharInfo, or a player's SetPlayerData). Other ` +
        `resources reading charinfo.phone will see a stale number. Reported once per ` +
        `resource start.`
    );
    return;
  }

  let written = false;
  try {
    written = player.setPhone(value);
  } catch (error) {
    console.error(
      `[mica] writing ${who(player.citizenid)}'s number back to the framework threw.`,
      traceOf(error)
    );
    return;
  }

  if (!written) {
    reportOnce(
      'write-refused',
      `[mica] the framework refused to take ${who(player.citizenid)}'s phone number. micaOS is ` +
        `still the source of truth and the phone works; other resources reading ` +
        `charinfo.phone will see a stale number. Reported once per resource start.`
    );
    return;
  }
  // No line for a write-back that worked (MICA-433): it paired a citizenid with a number.
};

const ESX_KEEPS_THE_NUMBER =
  `[mica] this server runs es_extended, which has no standard way to set a character's ` +
  `phone number, so micaOS keeps reading the number your phone-number resource provides ` +
  `and issues none of its own. A number here is the character's, not the phone's. ` +
  `Reported once per resource start.`;

/**
 * Whether `citizenid` is still the character on `src` (MICA-336). A sync is started for one
 * character and awaits the database; a multichar switch can land in any of those awaits,
 * keeping the source. Everything after an await that would act through the source — above all
 * the write-back, which qbx_core's `SetCharInfo` addresses by source, so it would give the next
 * character the previous one's number — is abandoned once this is false. The next character's
 * load runs a sync of its own.
 */
const stillOn = (src: number, citizenid: string): boolean =>
  FrameworkBridge.getPlayer(src)?.citizenid === citizenid;

const syncOnce = async (src: number): Promise<string | null> => {
  const kind = detectFramework();
  if (kind === 'esx') {
    reportOnce('esx', ESX_KEEPS_THE_NUMBER);
    return null;
  }
  // `unknown` is the framework not having started yet; a later trigger will find it.
  if (kind !== 'standalone' && kind !== 'qb') return null;

  const player = FrameworkBridge.getPlayer(src);
  // No citizenid means the bridge already refused to name this player and said why. There is
  // nothing to key a number on, and inventing one is the mistake `unidentified` exists to
  // prevent.
  if (!player?.citizenid) return null;

  const resolution = await resolvePhone(src);
  if (!stillOn(src, player.citizenid)) return null;
  // Holding no phone on a server that gates on one: nothing to resolve, and nothing to
  // change. The cache and the framework keep whatever they last had — see `writeBack`.
  if (resolution.status === 'none') return null;

  // Only qb has a framework-issued number worth adopting. Standalone's `charinfo.phone` *is*
  // micaOS's own cache, and ESX never reaches here.
  const preferred = kind === 'qb' ? frameworkNumber(player) : null;

  /**
   * The phone either way (MICA-439): the one in hand on a gated server, the citizen's one phone
   * where nothing is counted. Both read the phone's own number row, so a phone item turned off
   * after it was on, or on after off, keeps the number with the phone. Before MICA-439 the
   * ungated path read only a legacy row, missed the one already attached to the phone, was
   * refused the framework's number by `number_unique`, and issued and wrote back a second one
   * while calls and texts (`numberOfPhone`) went on carrying the first.
   */
  const phone =
    resolution.status === 'active'
      ? resolution.device
      : { deviceId: await identityPhone(player.citizenid) };
  if (!stillOn(src, player.citizenid)) return null;

  const resolved = await numberForPhone(phone, player.citizenid, preferred);
  if (!resolved || !stillOn(src, player.citizenid)) return null;

  rememberNumber(player.citizenid, resolved);
  writeBack(player, resolved);
  return resolved;
};

/** Start a run for `src` and make it the one in flight. */
const begin = (src: number, citizenid: string | null): Promise<string | null> => {
  const entry: SyncRun = { citizenid, run: syncOnce(src), again: null };
  entry.run = entry.run.finally(() => {
    // Only its own entry: a later character's sync, or the run queued behind this one, may
    // have taken the key meanwhile.
    if (syncing.get(src) === entry) syncing.delete(src);
  });
  syncing.set(src, entry);
  return entry.run;
};

/** Its outcome is the run's own callers' to read; the run behind it only waits for it. */
const whateverHappened = (): void => undefined;

/**
 * The run behind `pending`, started once it ends. Two things can have changed by then. The
 * source can carry a different character, whose own load runs their sync, so this one does
 * nothing (MICA-336). Or a trigger since `pending` ended can have started a run already. That
 * run picked the phone after every trigger queued here, so they share it.
 */
const queueBehind = (src: number, pending: SyncRun): Promise<string | null> =>
  pending.run.then(whateverHappened, whateverHappened).then(() => {
    if ((FrameworkBridge.getPlayer(src)?.citizenid ?? null) !== pending.citizenid) return null;
    const current = syncing.get(src);
    if (current && current.citizenid === pending.citizenid) return current.run;
    return begin(src, pending.citizenid);
  });

/**
 * Bring a source's number into line with the phone they are on.
 *
 * Runs whenever that could have changed: on load, on using a phone item, and on the client's
 * relay of an inventory change (the same trigger that decides whether the phone is held at
 * all). Idempotent when nothing changed — the caches answer, no query runs, no write-back
 * happens — which is what makes it safe to hang off a client-triggered event; the only thing
 * a modified client can do is ask often, and `guardNetEvent` bounds that.
 *
 * One in flight per source, so two triggers a tick apart on a load never run two assignment
 * loops side by side. A trigger while one runs gets the run queued behind it (`syncing` has
 * why), which answers for the phone in hand once that run ends.
 */
export const syncNumber = (src: number): Promise<string | null> => {
  const citizenid = FrameworkBridge.getPlayer(src)?.citizenid ?? null;
  const pending = syncing.get(src);
  if (!pending || pending.citizenid !== citizenid) return begin(src, citizenid);

  if (!pending.again) pending.again = queueBehind(src, pending);
  return pending.again;
};

/**
 * Subscribed to the phone-item registry rather than to `onPlayerLoaded` directly, because the
 * registry is fired from every place a player's phone in hand can change — the load, the
 * usable-item callback, the inventory relay — and a subscriber of `onPlayerLoaded` alone would be
 * right at connect and stale the moment a player who held no phone picked one up. A character
 * has one phone (MICA-438), so what changes is only whether they hold it. `lib/deviceItem.ts`
 * has why the source it hands over is one already established (MICA-136).
 */
onPhoneStateChanged('phonenumbers', (src) => syncNumber(src));
