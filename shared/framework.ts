// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Framework identity, in the one place both FiveM targets can reach it.
 *
 * `client/lib/FrameworkBridge.ts` and `server/lib/FrameworkBridge.ts` are separate build
 * targets that cannot import each other, and both have to agree about what a player's
 * `citizenid` is — the client sends it to the UI for display, the server keys every row and
 * every ownership predicate on it. Two copies of that rule is two places for it to stop
 * being the same rule, and the symptom would be a phone showing one identity and serving
 * another's data.
 */

/**
 * How wide a citizenid column is, which depends on what the rows hang off (MICA-289).
 *
 * A citizenid column is as wide as the owner key it holds. On qb that is
 * `players.citizenid`, a `varchar(50)`: nothing wider can exist there, so the column stays 50
 * and `mica.sql` does not move. On ESX it is
 * `users.identifier`, a `varchar(60)`, and a multicharacter `char1:license:<40 hex>` is 54 —
 * a column of 50 cost that player their phone. Standalone mints `license:<hash>` identifiers
 * and ships `mica.esx.sql`, so it takes the ESX width too.
 *
 * `ownerTable` is `schemaSql.ts`'s own axis: is qb's `players(citizenid)` the owner? (Nothing
 * references it with a foreign key since MICA-300; only the width follows from the answer.)
 * The DDL, the planner and the write guard all ask through this function, so the three cannot
 * disagree about one server.
 */
export const QB_CITIZENID_WIDTH = 50;
export const IDENTIFIER_CITIZENID_WIDTH = 60;
export const citizenIdWidth = (ownerTable: boolean): number =>
  ownerTable ? QB_CITIZENID_WIDTH : IDENTIFIER_CITIZENID_WIDTH;

/**
 * The widest `citizenid` any schema can hold, in characters: the ESX width.
 *
 * **Derived from the widths above, not a copy of them**, so widening a column and widening
 * the guard stay one edit (MICA-158). It bounds `citizenIdFromIdentifier`, which only ESX and
 * standalone derive a citizenid through — qb's comes from `players`, which cannot hold more
 * than 50 — so the widest width is the right bound on every framework that asks.
 */
export const CITIZENID_MAX_LENGTH = Math.max(QB_CITIZENID_WIDTH, IDENTIFIER_CITIZENID_WIDTH);

/** Why an identifier could not become a citizenid. Null when it can. */
type IdentifierRejection = 'not-a-string' | 'empty' | 'too-long';

/**
 * The `citizenid` micaOS keys an ESX player's rows on.
 *
 * **The decision, stated rather than implied.** ESX has no citizenid. It identifies a player
 * by `identifier` — `license:<40 hex>`, `steam:<id>`, `fivem:<id>` — and issues it per
 * *account*, where qb issues a citizenid per *character*. An ESX identifier is mapped
 * straight onto `citizenid`, so on ESX one **player** has one phone, and on qb one
 * **character** has one phone. That difference is the intended behaviour for ESX, not a
 * compromise made to get an adapter to compile.
 *
 * **Why it is a function rather than a field assignment in each adapter branch.** `citizenid`
 * is the ownership predicate in every `WHERE` clause on the server (AGENTS.md §2.9) and a
 * column on every table — 229 uses in `server/lib/` alone, across 22 files under
 * `server/services/`. A mapping written in one named place can be changed by one edit: a
 * server owner running an ESX multicharacter addon that suffixes the identifier per slot
 * changes this function and no call site, and gets per-character phones on both sides at
 * once. A mapping spelled out at each branch would have to be found first, and whichever
 * copy was missed would stay invisible until two characters shared an inbox.
 *
 * **Why length is refused rather than trimmed to fit.** Nothing downstream would catch it:
 * `citizenid` is never client-writable, so `Repository.assertWritableValue` — the guard that
 * length-checks every other column against its declaration — deliberately never looks at
 * this one. An over-long identifier therefore reached MySQL unexamined, and MySQL decided.
 * Under `STRICT_TRANS_TABLES`, MariaDB's default, that is `ERROR 1406` on every write the
 * player makes: no notes, no messages, no contacts. Under a permissive `sql_mode` it is
 * worse, because it succeeds — the value is silently cut to fit, micaOS stays
 * self-consistent by writing and reading the same truncated string, and the phone appears to
 * work while the stored id no longer equals that player's `users.identifier`. Every join
 * across the two then misses: `findOfflineByCitizenId` renders them nameless, and the orphan
 * sweep (MICA-152) reads their rows as belonging to nobody and **deletes them**.
 *
 * Refusing is the only option that is safe in both modes. It costs the player a phone, which
 * strict mode was already costing them, and it says so at the point of derivation instead of
 * as an errno inside oxmysql. A truncating or hashing fix would buy a working-looking phone
 * by making the id something no other table can join to, which is the failure above with the
 * alarm switched off.
 *
 * Null rather than a placeholder, matching what the bridges do with an unnameable qb player:
 * an identity micaOS cannot read is not one it invents.
 */
export const citizenIdFromIdentifier = (identifier: unknown): string | null => {
  if (typeof identifier !== 'string') return null;
  const trimmed = identifier.trim();
  if (trimmed.length === 0 || trimmed.length > CITIZENID_MAX_LENGTH) return null;
  return trimmed;
};

/**
 * Why `citizenIdFromIdentifier` said no, for the log line that follows it.
 *
 * Separate from the mapping rather than folded into its return type, because every call site
 * on both targets wants the citizenid and only the ones that report a refusal want the
 * reason. A discriminated result would have made all of them unwrap a wrapper to reach the
 * common case.
 *
 * Kept beside the mapping so the two cannot disagree about what is acceptable — the ordering
 * of the checks here is the ordering there. Module-local: `describeIdentifierRejection` is
 * the whole reason it exists, and an exported second way to ask the same question is a
 * second thing to keep in step with the first.
 */
const identifierRejection = (identifier: unknown): IdentifierRejection | null => {
  if (typeof identifier !== 'string') return 'not-a-string';
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > CITIZENID_MAX_LENGTH) return 'too-long';
  return null;
};

/**
 * One sentence naming what was wrong, for an operator reading a console.
 *
 * `too-long` carries the measured length and the limit, because that is the one rejection an
 * operator can act on — it usually means a multicharacter addon is prefixing the identifier,
 * and the numbers say by how much.
 */
export const describeIdentifierRejection = (identifier: unknown): string => {
  switch (identifierRejection(identifier)) {
    case 'not-a-string':
      return 'the framework supplied no identifier string';
    case 'empty':
      return 'the identifier was empty';
    case 'too-long':
      return (
        `the identifier is ${(identifier as string).trim().length} characters and ` +
        `citizenid holds ${CITIZENID_MAX_LENGTH}`
      );
    default:
      return 'no reason: the identifier is acceptable';
  }
};
