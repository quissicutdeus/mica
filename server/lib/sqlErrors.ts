// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Telling one database failure from another, across the two shapes a failure arrives in.
 *
 * mysql2 in-process — `test:schema`, `test:migrations` — rejects with an `Error` carrying
 * `errno` and `code`. oxmysql across a resource boundary, which is every real server, rejects
 * with text only (`new Error(output)`): "<resource> was unable to execute a query!", then the
 * query, then its parameters, and mysql2's own message on the **last** line. No `errno`, no
 * `code`. A check that reads `errno` alone passes every in-process suite and never fires in
 * game; one that matches the whole text matches the statement's own parameters.
 */

/**
 * What a thrown value says, from any realm: its `message` when it has a string one, the value
 * itself when it is a string, `String(value)` for anything else — and '' for `null`,
 * `undefined`, a value whose `String` is only `[object Object]`, or one whose `message` getter
 * or `toString` throws. Called from inside a `catch`, so nothing here may throw.
 *
 * Never `instanceof Error`. oxmysql builds its rejection with `new Error(output)` inside its own
 * resource, so in micaOS's realm that check is false on every real driver failure and a reason
 * read through it is empty. `errorReasons.test.ts` fails a `.message` read behind one anywhere
 * in `server/`.
 */
const textOf = (error: unknown): string => {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  try {
    if (typeof error === 'object' && 'message' in error) {
      const message: unknown = error.message;
      if (typeof message === 'string') return message;
    }
    const text = String(error);
    // A plain object says nothing about what went wrong.
    return /^\[object [A-Za-z]+\]$/.test(text) ? '' : text;
  } catch {
    // A throwing `message` getter, a Proxy, or an object with no prototype and so no `toString`.
    return '';
  }
};

const OXMYSQL_HEADER = /unable to execute a query!/;

/**
 * Why something failed, fit for one log line: the last non-empty line of what the error says.
 *
 * In oxmysql's shape that is mysql2's own message and nothing of the statement or its
 * parameters above it; in mysql2's shape, or any one-line message, it is the whole text. When
 * mysql2's message is empty — Node's dual-stack `ECONNREFUSED` is an `AggregateError` with
 * `message: ''` — oxmysql's last line is the parameters, or the query, or its own header, and
 * none of those is answered, so a caller logging it never prints a player's message body.
 *
 * `fallback` (default '') is what to answer when there is no line to give: a caller whose line
 * would otherwise end "failed: " with nothing after it passes `NO_REASON`.
 */
export const reasonOf = (error: unknown, fallback = ''): string => {
  const text = textOf(error);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines[lines.length - 1] ?? '';
  if (
    OXMYSQL_HEADER.test(text) &&
    (last.startsWith('[') ||
      last.startsWith('{') ||
      /^Query:/i.test(last) ||
      OXMYSQL_HEADER.test(last))
  ) {
    return fallback;
  }
  return last === '' ? fallback : redactDuplicateValue(last);
};

/**
 * A duplicate-key message with the value it names left out (MICA-433): mysql2's
 * `Duplicate entry '<value>' for key '<key>'`. The value is whatever collided — a citizenid, a
 * phone number, a phone id, a handle — and the key name is what an operator acts on, so the
 * key stays and the value goes. Up to the last `' for key '`, since the value itself may hold
 * a quote.
 */
const redactDuplicateValue = (line: string): string =>
  line.replace(/(Duplicate entry ')[\s\S]*(' for key ')/i, '$1…$2');

/** For a reason that would otherwise print as nothing at all. */
export const NO_REASON = 'no reason was given';

/**
 * Why something failed, and where (MICA-433): `reasonOf`'s one line, then the stack's own
 * frames and nothing else of it. For a failure nobody expected, where the frames are what a
 * server owner needs, logged without the message above them — the first line of an oxmysql
 * error's stack is its message, statement, bound values and all.
 *
 * A frame is a line that starts `at `; whatever else a stack carries is dropped. Never throws.
 */
export const traceOf = (error: unknown): string => {
  const reason = reasonOf(error, NO_REASON);
  let stack = '';
  try {
    if (error !== null && typeof error === 'object' && 'stack' in error) {
      const raw: unknown = error.stack;
      if (typeof raw === 'string') stack = raw;
    }
  } catch {
    // A throwing `stack` getter; the reason alone will do.
  }
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '));
  return frames.length > 0 ? `${reason}\n    ${frames.join('\n    ')}` : reason;
};

/**
 * Did this write fail on a unique key (ER 1062)?
 *
 * The callers need it told apart from every other failure because the two want opposite
 * answers: a duplicate is the row already being there (a contact the phone has, a number a
 * racing assignment took), while a dropped connection or a missing table means stop and say
 * so. Treating both alike turns "the table was never imported" into a quiet skip.
 *
 * Only the driver's message is read, so a parameter that says "Duplicate entry" — a contact's
 * name, a message body — cannot classify its own statement. The message names the key as
 * MariaDB and MySQL 8 do (`table.key`) and as older servers did (`key` alone).
 *
 * It replaced `lib/phoneNumbers.ts`' `isDuplicateEntry` (MICA-335), which read the whole text
 * and so could match its own parameters.
 */
export const isDuplicateKey = (error: unknown): boolean => {
  if (error && typeof error === 'object') {
    const { errno, code } = error as { errno?: unknown; code?: unknown };
    if (errno === 1062) return true;
    if (typeof code === 'string' && code.toUpperCase() === 'ER_DUP_ENTRY') return true;
  }
  if (error === null || error === undefined) return false;
  return /\bDuplicate entry\b.*\bfor key\b/i.test(reasonOf(error));
};
