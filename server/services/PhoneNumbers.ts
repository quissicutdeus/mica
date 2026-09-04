// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import { detectFramework, FrameworkBridge } from '../lib/FrameworkBridge';
import { onPlayerLoaded } from '../lib/shell';
import {
  ACTIVE_STATUS,
  generatePhoneNumber,
  isDuplicateEntry,
  MAX_ASSIGN_ATTEMPTS,
  numberFor,
  PHONE_NUMBERS_TABLE,
  readAssignedRow,
  rememberNumber,
  type PhoneNumberRow
} from '../lib/phoneNumbers';

/**
 * The one table micaOS owns a phone number in (MICA-151).
 *
 * **The decision this table represents, stated rather than implied.** micaOS owns no numbers
 * today: on qb the number is `charinfo.phone`, on ESX it is whichever field the operator's
 * community phone-number resource writes, and in both cases the framework is the source of
 * truth. Standalone has neither, and without a number `getPlayerByPhone`, dialling and
 * `conversations:create` resolve nobody — so Phone, Messages and Contacts do not work at all.
 *
 * **The table is declared for every framework; the assignment is standalone-only.** Those are
 * two separate decisions and they were made separately.
 *
 * The DDL is unconditional because the generated artifacts are not per-framework subsets of
 * the schema — `mica.sql` and `mica.esx.sql` contain the same tables and differ only in
 * whether the foreign keys onto `players` are emitted (see `SchemaSqlOptions.ownerTable`).
 * Emitting this table only for standalone would mean a third artifact and a third thing for a
 * server owner to import the wrong one of, to save an empty table.
 *
 * The *assignment* is gated on `detectFramework() === 'standalone'` because a second source
 * of truth for a phone number is precisely the drift `FrameworkBridge` exists to prevent. A
 * qb server's `charinfo.phone` is what every other resource on that server reads — the job
 * script that texts you, the dispatch system, the framework's own admin menu — and a micaOS
 * number sitting beside it would be a number the phone believes and nothing else does. It
 * would also be a number micaOS would have to write back into `charinfo` to make real, which
 * is a micaOS write into a table it does not own, and §10's rule against that is not
 * negotiable. So on qb and ESX this table stays empty, and micaOS keeps reading the number
 * the framework already issued.
 *
 * If a later ticket does want micaOS to own numbers everywhere, the change is to widen the
 * gate below and to migrate the existing framework numbers into this table in the same
 * commit — never to leave both sources live at once.
 *
 * **Nothing here is reachable from a client.** `write: 'server'` turns off the generic create
 * and update, and `disableGet`/`disableDelete` turn off the other two, so this declaration
 * registers no net event at all — a number is assigned by the server on connect and is never
 * something a payload gets to set, choose or delete (§2.9, and `reachability.test.ts` keeps
 * the registered set deliberate).
 */
export const phoneNumbers = defineService<PhoneNumberRow>({
  id: 'phonenumbers',
  table: PHONE_NUMBERS_TABLE,
  access: { read: 'owner', write: 'server' },
  schema: {
    /**
     * 16 characters rather than the 7 a generated number occupies. `netGuard.phoneNumberFrom`
     * accepts up to 32 off the wire, and a framework number that ends up here through some
     * later migration may carry formatting this one does not — the column should not be the
     * thing that refuses it.
     */
    number: { type: 'string', length: 16, notNull: true, clientWritable: false }
  },
  indexes: [
    /**
     * **Uniqueness is the schema's job, not the application's.** Both keys below are what the
     * assignment loop trusts: it generates, inserts, and reads the violation, rather than
     * checking first and inserting second. A check-then-insert has a race between two players
     * connecting in the same tick that no amount of care in TypeScript closes, and a duplicate
     * number is not a cosmetic problem — two players would receive each other's messages.
     *
     * `number` unique: no two players share a number. `citizenid` unique: no player has two,
     * which is what makes a number stable across a reconnect rather than reissued.
     */
    { name: 'number_unique', columns: ['number'], unique: true },
    /**
     * **`citizenid_unique` is on the citizenid alone, and is deliberately status-blind.**
     *
     * That is not an oversight, and it is the one thing about this table a later change can
     * get wrong without any suite noticing, so it is written down here rather than left to be
     * rediscovered against a live database.
     *
     * `defineService` supplies a `status` ENUM carrying `'deleted'` on every table by
     * construction, and `lib/retention.ts` is explicit that **nothing in this codebase ever
     * hard-deletes a soft-deleted row** — the moderation system depends on one surviving
     * forever, and there is no sweep that eventually frees the slot. So a row here that ever
     * reached `status = 'deleted'` would occupy its citizenid's slot permanently: every
     * subsequent insert for that player violates this key no matter which number it carries,
     * `ensureNumber` burns all its attempts on a collision no new candidate can resolve, and
     * the symptom is a player who silently never gets a phone number again.
     *
     * Adding `status` to the key would be the wrong fix twice over. It would let one player
     * hold several numbers, which is the thing this key exists to prevent, and it would make
     * "which of these is theirs" a question with more than one answer everywhere the number is
     * read — `findOfflineByCitizenId`, the cache, the reverse lookup by number.
     *
     * The right fix is that **assignment restores rather than inserts**: `ensureNumber` treats
     * an existing row of any status as this player's number and brings it back to `'active'`.
     * A phone number is the player's identity, not a piece of their content, so a number
     * returning after a soft-delete is the correct behaviour rather than a workaround — and
     * doing it there makes the whole class of bug unreachable instead of merely documented.
     *
     * Not reachable today: `write: 'server'` and `disableDelete` leave no path that sets
     * `'deleted'` on this table at all. The next person to add one — a "release a number"
     * action, a character-cleanup sweep — should find this note before they find the bug.
     */
    { name: 'citizenid_unique', columns: ['citizenid'], unique: true }
  ],
  options: { disableGet: true, disableDelete: true }
});

/**
 * This player's existing row, brought back to life if it needs it.
 *
 * The other half of the `citizenid_unique` invariant documented on the index above. A row
 * here is the player's identity rather than a piece of their content, so any status is still
 * *their* number: a soft-deleted row is reactivated and its number returned, not treated as
 * an obstacle. Without that, a single soft-delete would wedge the citizenid forever —
 * `lib/retention.ts` never hard-deletes, so nothing would ever free the slot — and the
 * symptom would be a player who silently never gets a number again.
 *
 * **Not `Repository.restore`**, which is the right method for a player undoing their own
 * delete and the wrong one here: it is bounded by a `windowDays` measured off `updated_at`,
 * so a row soft-deleted longer ago than the restore window would match nothing and this would
 * be back to the wedge. A number has to come back regardless of how long it has been gone.
 *
 * The ownership-scoped `update` rather than anything unscoped: the citizenid is the one the
 * server resolved for this connection, never a payload, so this is the ordinary predicate
 * path and not a bypass of it (§2.9).
 *
 * A failed reactivation is logged and the number is still returned. The row is theirs either
 * way, every read of this table is status-blind by design, and refusing to tell a player
 * their own number because a status column would not move is a worse outcome than a stale
 * status with a line in the log.
 */
const claimExistingRow = async (citizenid: string): Promise<string | null> => {
  const row = await readAssignedRow(citizenid);
  if (!row) return null;

  if (row.status !== ACTIVE_STATUS) {
    const reactivated = await phoneNumbers.repo.update(
      row.id,
      { status: ACTIVE_STATUS } as Partial<PhoneNumberRow>,
      citizenid
    );
    if (!reactivated) {
      console.error(
        `[mica] could not reactivate the soft-deleted phone number row for ${citizenid}. ` +
          `They keep the number ${row.number} — every read of ${PHONE_NUMBERS_TABLE} is ` +
          `status-blind on purpose — but the row is still marked '${row.status}'.`
      );
    }
  }

  rememberNumber(citizenid, row.number);
  return row.number;
};

/**
 * The number for a citizenid, assigning one the first time and never again.
 *
 * Three things have to be true at once, and the order below is what makes them so:
 *
 * - **Stable.** A returning player keeps the number they had, or every contact anybody saved
 *   for them points at somebody else. That is why the cache and the table are consulted
 *   before anything is generated, and why nothing here ever updates a row.
 * - **Unique.** Enforced by the unique key on `number` (see the declaration). This generates,
 *   attempts the insert, and reads the failure — it does not pre-check with a `SELECT`, which
 *   would leave a window between the check and the write.
 * - **Bounded.** `MAX_ASSIGN_ATTEMPTS` collisions in a row means the space is genuinely full
 *   rather than unlucky, and that is reported rather than retried forever or, far worse,
 *   papered over by handing out a number somebody already has.
 *
 * A duplicate can come from either key, and they mean opposite things. A duplicate `number`
 * is an ordinary collision: generate another. A duplicate `citizenid` means a row for this
 * player already exists — a concurrent connect won the race, or a soft-deleted row from
 * before is still holding the slot — so `claimExistingRow` takes it, rather than looping
 * until the attempts run out on a conflict no new candidate can resolve.
 *
 * Returns null on failure rather than throwing. The caller is a player-loaded subscriber, and
 * `dispatchPlayerLoaded` is explicit that a subscriber must not be able to fail a connection;
 * a player with no number has a phone that cannot be dialled, which is worse than a phone and
 * better than no connection.
 */
export const ensureNumber = async (citizenid: string): Promise<string | null> => {
  if (!citizenid) return null;

  const cached = numberFor(citizenid);
  if (cached) return cached;

  const existing = await claimExistingRow(citizenid);
  if (existing) return existing;

  for (let attempt = 1; attempt <= MAX_ASSIGN_ATTEMPTS; attempt++) {
    const candidate = generatePhoneNumber();

    try {
      await phoneNumbers.repo.create({ citizenid, number: candidate } as Partial<PhoneNumberRow>);
      rememberNumber(citizenid, candidate);
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

      /**
       * A duplicate came from one of the two keys and they mean opposite things.
       *
       * `number_unique` is an ordinary collision: nothing exists for this citizenid, this
       * returns null, and the loop generates another candidate. `citizenid_unique` means a
       * row for this player is already there — put there by a concurrent connect, or sitting
       * soft-deleted from before — and no new candidate will ever get past it, so the row is
       * claimed and returned instead of retried.
       */
      const claimed = await claimExistingRow(citizenid);
      if (claimed) return claimed;
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
 * Assign on connect, and only where micaOS owns the number.
 *
 * Through `onPlayerLoaded` rather than a listener of its own, for the reason the registry
 * documents: a subscriber is handed a source that has already been established, so it has no
 * identity to resolve and therefore none to get wrong (MICA-136). On standalone the entry
 * point behind it is `playerJoining`, where the connection is the only thing on offer.
 *
 * The framework check is here rather than inside `ensureNumber` so that the function stays
 * usable by a future caller that has already decided, and so that this file has exactly one
 * place expressing "micaOS owns numbers only on standalone".
 */
onPlayerLoaded('phonenumbers', async (src) => {
  if (detectFramework() !== 'standalone') return;

  const citizenid = FrameworkBridge.getCitizenId(src);
  // No citizenid means the bridge already refused to name this player and said why. There is
  // nothing to key a number on, and inventing one is the mistake `unidentified` exists to
  // prevent.
  if (!citizenid) return;

  await ensureNumber(citizenid);
});
