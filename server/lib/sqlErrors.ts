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
 * The driver's own message: the last non-empty line of the text, which in oxmysql's shape is
 * mysql2's message and nothing of the query or its parameters above it. The whole text when
 * it is one line, which is mysql2's own shape.
 */
const lastLine = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1] ?? '';
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
  return /\bDuplicate entry\b.*\bfor key\b/i.test(lastLine(error));
};
