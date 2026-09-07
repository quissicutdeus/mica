// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import { detectFramework, FrameworkBridge, type FrameworkPlayer } from '../lib/FrameworkBridge';
import { onPhoneStateChanged } from '../lib/phoneItem';
import {
  ACTIVE_STATUS,
  generatePhoneNumber,
  isDuplicateEntry,
  MAX_ASSIGN_ATTEMPTS,
  numberFor,
  PHONE_NUMBERS_TABLE,
  readLegacyRow,
  readRowByPhoneId,
  rememberNumber,
  type AssignedNumberRow,
  type PhoneNumberRow
} from '../lib/phoneNumbers';
import { PhoneNumberRepository } from '../repositories/PhoneNumberRepository';
import { resolvePhone, type ActivePhone } from './Phones';

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
 * operator's resource provides, issues nothing, and says so once at start. A stolen phone
 * there keeps the thief's own number, which is honest about what the framework allows.
 *
 * **A number attaches to a phone lazily**, because it has to. A phone id lives in inventory
 * item metadata (MICA-280) and can only be minted at runtime, when a player actually holds the
 * item; SQL cannot invent one. So the migration that ships with this gives every existing qb
 * character a **legacy row** — their current number, `phone_id` NULL — and the first time they
 * use a phone `syncNumber` attaches that row to it. Nobody's number changes on upgrade; it
 * moves onto their phone the first time they pick it up. A server whose inventory cannot carry
 * a phone id at all stays on legacy rows forever, which is exactly one number per citizen, as
 * before.
 *
 * **Nothing here is reachable from a client.** `write: 'server'` turns off the generic create
 * and update, and `disableGet`/`disableDelete` turn off the other two, so this declaration
 * registers no net event at all — a number is assigned by the server and is never something a
 * payload gets to set, choose or delete (§2.9, and `reachability.test.ts` keeps the registered
 * set deliberate). The two privileged writes it does need are named methods on
 * `PhoneNumberRepository`, which is where §2.9 says they go.
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
     * The phone this number is on: a `mica_phones.phone_id`, or NULL for a legacy row that is
     * a citizen's number not yet attached to any phone. Nullable on purpose — see the
     * declaration note — and deliberately **not a foreign key** onto `mica_phones`: the
     * additive half of `micaschema apply` adds columns and keys and never a constraint, so a
     * foreign key here would hold on a fresh install and not on an upgraded one. A constraint
     * that is true on half the servers is a lie, and the resolver in `Phones.ts` is what keeps
     * the two tables in step instead.
     */
    phone_id: { type: 'string', length: 32, clientWritable: false }
  },
  indexes: [
    /**
     * **Uniqueness is the schema's job, not the application's.** Both keys are what the
     * assignment loop trusts: it generates, inserts, and reads the violation, rather than
     * checking first and inserting second. A check-then-insert has a race between two players
     * connecting in the same tick that no amount of care in TypeScript closes, and a duplicate
     * number is not a cosmetic problem — two players would receive each other's messages.
     *
     * `number` unique: no two phones share a number. `phone_id` unique: a phone has one number
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
    { name: 'phone_id_unique', columns: ['phone_id'], unique: true }
  ],
  options: { disableGet: true, disableDelete: true },
  repositoryFactory: (resolved) => new PhoneNumberRepository(resolved)
});

const repo = phoneNumbers.repo as PhoneNumberRepository;

/**
 * Numbers this process has already resolved for a phone, so a re-sync with nothing changed
 * costs no query. Keyed by phone id; the holder is kept beside the number so a phone that has
 * changed hands since is noticed and re-read.
 */
const onPhone = new Map<string, { number: string; citizenid: string }>();

/**
 * One sync in flight per source. The phone-item relay and the usable-item callback can fire
 * within a tick of each other on a load, and two assignment loops for the same citizen would
 * happily issue two numbers now that nothing in the schema stops them.
 */
const syncing = new Map<number, Promise<string | null>>();

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
 * Make a row this citizen's, whatever state it is in, and hand back its number.
 *
 * Two things can be wrong with a row that is nevertheless the right one. It can be
 * soft-deleted — `lib/retention.ts` never hard-deletes, so a `'deleted'` row still holds the
 * number and is reactivated rather than treated as an obstacle. And it can be recorded against
 * whoever used the phone last, which for a phone that has just changed hands is not this
 * player; `transferToHolder` is the write that makes the number ring for them.
 *
 * The reactivation is the ordinary ownership-scoped `update`, scoped by the citizenid the row
 * carries *now*, which is known. The transfer cannot be — its whole point is that the row's
 * citizenid is about to be somebody else's — so it is the named privileged method.
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
      row.citizenid
    );
    if (!reactivated) {
      console.error(
        `[mica] could not reactivate the soft-deleted phone number row for ${row.number}. ` +
          `It is still ${citizenid}'s — every read of ${PHONE_NUMBERS_TABLE} is status-blind ` +
          `on purpose — but the row is still marked '${row.status}'.`
      );
    }
  }

  if (row.citizenid !== citizenid) {
    const moved = await repo.transferToHolder(row.id, citizenid);
    if (!moved) {
      console.error(
        `[mica] could not record that ${number(row)} is now held by ${citizenid}. They are ` +
          `using the phone it is on, so the phone answers to that number for them this ` +
          `session, but ${PHONE_NUMBERS_TABLE} still names ${row.citizenid}.`
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
 * generate another. A duplicate `phone_id` means a concurrent sync already gave this phone a
 * number, and no new candidate will get past that — so the winner's row is claimed instead.
 * With no phone id, the same question is asked of the citizen's legacy row.
 *
 * Returns null on failure rather than throwing. The callers are subscribers to the phone-item
 * registry, which must not be able to fail a load; a player with no number has a phone that
 * cannot be dialled, which is worse than a phone and better than no connection.
 */
const assign = async (
  citizenid: string,
  phoneId: string | null,
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
        ...(phoneId ? { phone_id: phoneId } : {})
      } as Partial<PhoneNumberRow>);
      return candidate;
    } catch (error) {
      if (!isDuplicateEntry(error)) {
        console.error(
          `[mica] could not assign a phone number to ${citizenid}. They will have a phone ` +
            `that cannot be dialled until this is fixed; nothing else is affected. If the ` +
            `table is missing, import the schema for this server (${PHONE_NUMBERS_TABLE}).`,
          error
        );
        return null;
      }

      const winner = phoneId ? await readRowByPhoneId(phoneId) : await readLegacyRow(citizenid);
      if (winner) return await claimRow(winner, citizenid);

      if (candidate === preferred) {
        console.warn(
          `[mica] the framework's number ${preferred} for ${citizenid} is already on another ` +
            `phone, so they are being issued a fresh one. It is written back into the ` +
            `framework, so other resources see the new number too.`
        );
      }
    }
  }

  console.error(
    `[mica] gave up assigning a phone number to ${citizenid} after ${MAX_ASSIGN_ATTEMPTS} ` +
      `attempts, every one of which collided with a number already issued. That means the ` +
      `number space is close to exhausted rather than that this player was unlucky — see ` +
      `lib/phoneNumbers.ts, which sizes it. No number was issued and none was reused.`
  );
  return null;
};

/**
 * The number for a citizen with no phone identity: the legacy path, and the whole path on a
 * server that cannot carry a phone id.
 *
 * Stable across reconnects because the cache and the legacy row are consulted before anything
 * is generated. `preferred` is the framework's own number, adopted on the first sync so that a
 * qb server with no phone item — where this is every player, forever — keeps every number it
 * already had.
 */
export const ensureNumber = async (
  citizenid: string,
  preferred: string | null = null
): Promise<string | null> => {
  if (!citizenid) return null;

  const cached = numberFor(citizenid);
  if (cached) return cached;

  const legacy = await readLegacyRow(citizenid);
  if (legacy) {
    const claimed = await claimRow(legacy, citizenid);
    rememberNumber(citizenid, claimed);
    return claimed;
  }

  const issued = await assign(citizenid, null, preferred);
  if (issued) rememberNumber(citizenid, issued);
  return issued;
};

/**
 * Put the citizen's legacy number onto the phone in their hand.
 *
 * The upgrade path, and the reason nobody's number changes: the migration left their number
 * as a legacy row, and the first phone they use takes it. A duplicate here is a concurrent
 * sync that gave this phone a number first, and its row is claimed rather than fought over.
 */
const attachLegacy = async (
  legacy: AssignedNumberRow,
  phoneId: string,
  citizenid: string
): Promise<string | null> => {
  try {
    const attached = await repo.attachToPhone(legacy.id, phoneId);
    if (!attached) {
      console.error(
        `[mica] could not attach ${number(legacy)} to the phone ${citizenid} is using. It ` +
          `stays their number for this session; the next sync tries again.`
      );
    }
  } catch (error) {
    if (!isDuplicateEntry(error)) {
      console.error(`[mica] could not attach ${number(legacy)} to a phone.`, error);
      return null;
    }
    const winner = await readRowByPhoneId(phoneId);
    return winner ? await claimRow(winner, citizenid) : null;
  }
  return await claimRow(legacy, citizenid);
};

/**
 * The number on a phone, for the citizen holding it.
 *
 * In order: the number already on this phone, whoever it was recorded against — a phone that
 * changed hands is transferred to its holder here; the holder's legacy number, attached to
 * the phone; and finally a fresh assignment, preferring the framework's own value. That order
 * is what makes both stories true at once: a phone keeps its number through a robbery, and a
 * character keeps their number through the upgrade that introduced phones.
 */
const numberForPhone = async (
  phone: ActivePhone,
  citizenid: string,
  preferred: string | null
): Promise<string | null> => {
  const known = onPhone.get(phone.phoneId);
  if (known && known.citizenid === citizenid) return known.number;

  let resolved: string | null;
  const existing = await readRowByPhoneId(phone.phoneId);
  if (existing) {
    resolved = await claimRow(existing, citizenid);
  } else {
    const legacy = await readLegacyRow(citizenid);
    resolved = legacy
      ? await attachLegacy(legacy, phone.phoneId, citizenid)
      : await assign(citizenid, phone.phoneId, preferred);
  }

  if (resolved) onPhone.set(phone.phoneId, { number: resolved, citizenid });
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
      `[mica] writing ${player.citizenid}'s number back to the framework threw.`,
      error
    );
    return;
  }

  if (!written) {
    reportOnce(
      'write-refused',
      `[mica] the framework refused to take ${player.citizenid}'s phone number. micaOS is ` +
        `still the source of truth and the phone works; other resources reading ` +
        `charinfo.phone will see a stale number. Reported once per resource start.`
    );
    return;
  }

  console.log(`[mica] ${player.citizenid} is now on ${value}; written back to the framework.`);
};

const ESX_KEEPS_THE_NUMBER =
  `[mica] this server runs es_extended, which has no standard way to set a character's ` +
  `phone number, so micaOS keeps reading the number your phone-number resource provides ` +
  `and issues none of its own. A phone that changes hands keeps the holder's own number ` +
  `here. Reported once per resource start.`;

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
  // Holding no phone on a server that gates on one: nothing to resolve, and nothing to
  // change. The cache and the framework keep whatever they last had — see `writeBack`.
  if (resolution.status === 'none') return null;

  // Only qb has a framework-issued number worth adopting. Standalone's `charinfo.phone` *is*
  // micaOS's own cache, and ESX never reaches here.
  const preferred = kind === 'qb' ? frameworkNumber(player) : null;

  const resolved =
    resolution.status === 'active'
      ? await numberForPhone(resolution.phone, player.citizenid, preferred)
      : await ensureNumber(player.citizenid, preferred);
  if (!resolved) return null;

  rememberNumber(player.citizenid, resolved);
  writeBack(player, resolved);
  return resolved;
};

/**
 * Bring a source's number into line with the phone they are on.
 *
 * Runs whenever that could have changed: on load, on using a phone item, and on the client's
 * relay of an inventory change (the same trigger that decides whether the phone is held at
 * all). Idempotent when nothing changed — the caches answer, no query runs, no write-back
 * happens — which is what makes it safe to hang off a client-triggered event; the only thing
 * a modified client can do is ask often, and `guardNetEvent` bounds that.
 *
 * One in flight per source, so two triggers a tick apart on a load share a result instead of
 * running two assignment loops.
 */
export const syncNumber = (src: number): Promise<string | null> => {
  const pending = syncing.get(src);
  if (pending) return pending;

  const run = syncOnce(src).finally(() => {
    syncing.delete(src);
  });
  syncing.set(src, run);
  return run;
};

/**
 * Subscribed to the phone-item registry rather than to `onPlayerLoaded` directly, because the
 * registry is fired from every place the active phone can change — the load, the usable-item
 * callback, the inventory relay — and a subscriber of `onPlayerLoaded` alone would be right at
 * connect and stale the moment a player picked up a second phone. `lib/phoneItem.ts` has why
 * the source it hands over is one already established (MICA-136).
 */
onPhoneStateChanged('phonenumbers', (src) => syncNumber(src));
