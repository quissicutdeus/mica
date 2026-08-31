import { defineService } from '../lib/defineService';
import { detectFramework, FrameworkBridge } from '../lib/FrameworkBridge';
import { onPlayerLoaded } from '../lib/shell';
import {
  generatePhoneNumber,
  isDuplicateEntry,
  MAX_ASSIGN_ATTEMPTS,
  numberFor,
  PHONE_NUMBERS_TABLE,
  readNumber,
  rememberNumber,
  type PhoneNumberRow
} from '../lib/phoneNumbers';

/**
 * The one table gPhone owns a phone number in (MICA-151).
 *
 * **The decision this table represents, stated rather than implied.** gPhone owns no numbers
 * today: on qb the number is `charinfo.phone`, on ESX it is whichever field the operator's
 * community phone-number resource writes, and in both cases the framework is the source of
 * truth. Standalone has neither, and without a number `getPlayerByPhone`, dialling and
 * `conversations:create` resolve nobody — so Phone, Messages and Contacts do not work at all.
 *
 * **The table is declared for every framework; the assignment is standalone-only.** Those are
 * two separate decisions and they were made separately.
 *
 * The DDL is unconditional because the generated artifacts are not per-framework subsets of
 * the schema — `gphone.sql` and `gphone.esx.sql` contain the same tables and differ only in
 * whether the foreign keys onto `players` are emitted (see `SchemaSqlOptions.ownerTable`).
 * Emitting this table only for standalone would mean a third artifact and a third thing for a
 * server owner to import the wrong one of, to save an empty table.
 *
 * The *assignment* is gated on `detectFramework() === 'standalone'` because a second source
 * of truth for a phone number is precisely the drift `FrameworkBridge` exists to prevent. A
 * qb server's `charinfo.phone` is what every other resource on that server reads — the job
 * script that texts you, the dispatch system, the framework's own admin menu — and a gPhone
 * number sitting beside it would be a number the phone believes and nothing else does. It
 * would also be a number gPhone would have to write back into `charinfo` to make real, which
 * is a gPhone write into a table it does not own, and §10's rule against that is not
 * negotiable. So on qb and ESX this table stays empty, and gPhone keeps reading the number
 * the framework already issued.
 *
 * If a later ticket does want gPhone to own numbers everywhere, the change is to widen the
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
    { name: 'citizenid_unique', columns: ['citizenid'], unique: true }
  ],
  options: { disableGet: true, disableDelete: true }
});

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
 * is an ordinary collision: generate another. A duplicate `citizenid` means this player was
 * assigned a number by a concurrent connect between the read above and the insert — so the
 * row is re-read and the winner's number is returned, rather than looping until the attempts
 * run out on a conflict no new candidate can resolve.
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

  const existing = await readNumber(citizenid);
  if (existing) {
    rememberNumber(citizenid, existing);
    return existing;
  }

  for (let attempt = 1; attempt <= MAX_ASSIGN_ATTEMPTS; attempt++) {
    const candidate = generatePhoneNumber();

    try {
      await phoneNumbers.repo.create({ citizenid, number: candidate } as Partial<PhoneNumberRow>);
      rememberNumber(citizenid, candidate);
      return candidate;
    } catch (error) {
      if (!isDuplicateEntry(error)) {
        console.error(
          `[gphone] could not assign a phone number to ${citizenid}. They will have a phone ` +
            `that cannot be dialled until this is fixed; nothing else is affected. If the ` +
            `table is missing, import the schema for this server (${PHONE_NUMBERS_TABLE}).`,
          error
        );
        return null;
      }

      // Either the number was taken, or this player was assigned one by a concurrent
      // connect. Only the second is settled by looking.
      const raced = await readNumber(citizenid);
      if (raced) {
        rememberNumber(citizenid, raced);
        return raced;
      }
    }
  }

  console.error(
    `[gphone] gave up assigning a phone number to ${citizenid} after ${MAX_ASSIGN_ATTEMPTS} ` +
      `attempts, every one of which collided with a number already issued. That means the ` +
      `number space is close to exhausted rather than that this player was unlucky — see ` +
      `lib/phoneNumbers.ts, which sizes it. No number was issued and none was reused.`
  );
  return null;
};

/**
 * Assign on connect, and only where gPhone owns the number.
 *
 * Through `onPlayerLoaded` rather than a listener of its own, for the reason the registry
 * documents: a subscriber is handed a source that has already been established, so it has no
 * identity to resolve and therefore none to get wrong (MICA-136). On standalone the entry
 * point behind it is `playerJoining`, where the connection is the only thing on offer.
 *
 * The framework check is here rather than inside `ensureNumber` so that the function stays
 * usable by a future caller that has already decided, and so that this file has exactly one
 * place expressing "gPhone owns numbers only on standalone".
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
