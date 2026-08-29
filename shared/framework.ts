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
 * The `citizenid` gPhone keys an ESX player's rows on.
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
 * Null rather than a placeholder, matching what the bridges do with an unnameable qb player:
 * an identity gPhone cannot read is not one it invents.
 */
export const citizenIdFromIdentifier = (identifier: unknown): string | null => {
  if (typeof identifier !== 'string') return null;
  const trimmed = identifier.trim();
  return trimmed.length > 0 ? trimmed : null;
};
