// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Schema, StandardSchemaIssue } from '@mica/shared/schema';

/**
 * A custom action's reply, held to its contract's declared `output` (MICA-433).
 *
 * `shared/contract.ts` used to say the server does not validate its own replies, because a
 * wrong reply is a bug rather than an attack. MICA-433 is that bug: `bank:sendMoney` answered
 * `transfer()`'s outcome whole, recipient citizenid included, and nothing stood between a
 * handler's return value and the wire. Where an action declares a **real** reply schema, this
 * checks the reply against it on the way out.
 *
 * - **Under test** — vitest, or a server with `mica_integration` set (the in-server suite's
 *   test servers, never a live one) — a reply outside the declaration throws, which the
 *   endpoint answers generically and logs, so the suite that drives the handler fails loudly.
 * - **On a live server** the reply is sent as the schema reads it, so an undeclared field is
 *   stripped rather than leaked, and the mismatch is logged once per action. A reply the schema
 *   refuses outright (a missing or mistyped field) has nothing to strip; it is sent as it was,
 *   and logged once, rather than failing a player's request over a declaration.
 *
 * Fail closed on the leak, open on the shape: the stripped reply is the safe one, and a player
 * should not lose a working action because a declaration lagged a harmless field rename.
 *
 * A `responseType<T>()` output is a phantom with nothing to check against and passes untouched;
 * an action whose reply carries data about another player wants a real schema, with
 * `unknownKeys: 'strip'` on its objects so the live path has something to strip to.
 */

/** Whether a reply outside its declaration should throw rather than be stripped. */
const strict = (): boolean => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.VITEST) return true;
  return typeof GetConvar === 'function' && GetConvar('mica_integration', '') === '1';
};

/** One line per action per process: a mismatch on a busy action is not news every call. */
const said = new Set<string>();

/** Tests only. */
export const resetReplyShapeForTests = (): void => said.clear();

const isResponseOnly = (schema: Schema): boolean =>
  (schema as { '~responseOnly'?: boolean })['~responseOnly'] === true;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The paths present in `sent` that the schema's reading left out. Names only, never values:
 * this lands in a log, and the values are the very thing that should not.
 */
const droppedPaths = (sent: unknown, read: unknown, path = ''): string[] => {
  if (Array.isArray(sent) && Array.isArray(read)) {
    return sent.flatMap((item, index) => droppedPaths(item, read[index], `${path}[${index}]`));
  }
  if (!isPlainObject(sent) || !isPlainObject(read)) return [];
  return Object.keys(sent).flatMap((key) => {
    const at = path ? `${path}.${key}` : key;
    return key in read ? droppedPaths(sent[key], read[key], at) : [at];
  });
};

const describeIssues = (issues: readonly StandardSchemaIssue[]): string =>
  issues.map((issue) => issue.message).join('; ');

/**
 * The reply to send for `result`, by `output`. Throws under test when the two disagree.
 * `event` names the action in the error and the log line.
 */
export const checkReply = async (
  event: string,
  output: Schema | undefined,
  result: unknown
): Promise<unknown> => {
  if (!output || isResponseOnly(output)) return result;

  const outcome = await output['~standard'].validate(result);
  let problem: string;
  let send: unknown;
  if (outcome.issues) {
    problem = `does not match its declared shape: ${describeIssues(outcome.issues)}`;
    send = result;
  } else {
    const dropped = droppedPaths(result, outcome.value);
    if (dropped.length === 0) return outcome.value;
    problem = `carries undeclared field(s): ${dropped.join(', ')}`;
    send = outcome.value;
  }

  if (strict()) {
    throw new Error(`[mica] ${event} replied outside its contract: it ${problem}`);
  }
  if (!said.has(event)) {
    said.add(event);
    const how = outcome.issues ? 'Sent unchanged.' : 'Sent without them.';
    console.warn(`[mica] ${event} replied outside its contract: it ${problem}. ${how}`);
  }
  return send;
};

/** The two keys no reply carries (MICA-433). */
const OWNER_KEYS: ReadonlySet<string> = new Set(['citizenid', 'device_id']);

/**
 * A record to walk. Not by prototype: a row that crossed from oxmysql's resource is built in
 * another realm, whose `Object.prototype` is not this one's, and a prototype check would wave
 * exactly those through. Everything object-shaped is walked but a date and binary data.
 */
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !ArrayBuffer.isView(value) &&
  !(value instanceof ArrayBuffer);

/**
 * A reply with every `citizenid` and `device_id` key removed, at any depth (MICA-433).
 *
 * Every owner read used to answer whole rows — the generic `get` is a `SELECT *` — so the
 * caller's citizenid and phone id rode on every contact, photo, note and notification, and
 * through `useService` on every add-on's own rows, to code that never needs them: the client
 * already knows who it is, and asks the game for it (`getCitizenId`) rather than the server.
 * On ESX the citizenid is the player's Rockstar licence.
 *
 * At the reply rather than per query, so a custom action written tomorrow is covered without
 * remembering to be. Objects and arrays are copied rather than mutated, so a row a service keeps
 * cached is never changed under it; a `Date` or a `Buffer` passes as it is. A key under another name that holds a citizenid — `target_author`, `payee` — is that
 * reply's own projection to leave out.
 */
export const withoutOwnerKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutOwnerKeys);
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!OWNER_KEYS.has(key)) out[key] = withoutOwnerKeys(inner);
  }
  return out;
};
