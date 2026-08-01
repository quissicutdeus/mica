/**
 * Parsers for values arriving from NUI.
 *
 * Every id in a `gphone:server:*` payload is attacker-controlled (AGENTS.md §9),
 * so it is parsed and range-checked before it reaches SQL or an authorization
 * check. Shared here so services cannot drift into subtly different rules.
 */

/**
 * Coerce to a positive integer or throw. Rejects '', null, NaN, 0, negatives and
 * fractions — and rejects non-scalars up front, because `Number([7])` is `7`, so a
 * bare `Number()` coercion would quietly accept `{ id: [7] }` from a client.
 */
export function requirePositiveInt(raw: unknown, what: string): number {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error(`A valid ${what} is required.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`A valid ${what} is required.`);
  }
  return value;
}

/**
 * Pull a conversation id out of a payload. Accepts `{ conversation_id }`, `{ id }`,
 * or a bare id — the UI is not consistent about which it sends.
 */
export function conversationIdFrom(data: any): number {
  const raw = data && typeof data === 'object' ? (data.conversation_id ?? data.id) : data;
  return requirePositiveInt(raw, 'conversation_id');
}
