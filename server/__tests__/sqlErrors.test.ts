// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { isDuplicateKey } from '../lib/sqlErrors';

/**
 * The two shapes a failed statement arrives in (MICA-335). oxmysql's is the one every real
 * server sees and no in-process suite produces on its own: text only, the query and its
 * parameters first, mysql2's message last.
 */
const oxmysql = (params: unknown[], message: string): Error =>
  new Error(
    `mica was unable to execute a query!\nQuery: INSERT INTO \`mica_contacts\` (…) VALUES (?, ?)\n` +
      `${JSON.stringify(params)}\n${message}`
  );

describe('isDuplicateKey', () => {
  it.each([
    ['mysql2 in-process, by errno', Object.assign(new Error('x'), { errno: 1062 })],
    ['mysql2 in-process, by code', Object.assign(new Error('x'), { code: 'ER_DUP_ENTRY' })],
    [
      'oxmysql, a key named table.key (MariaDB 10.5+, MySQL 8)',
      oxmysql(['Ada'], "Duplicate entry 'a-555' for key 'mica_contacts.device_phone_unique'")
    ],
    [
      'oxmysql, a key named alone (older servers)',
      oxmysql(['Ada'], "Duplicate entry 'a-555' for key 'device_phone_unique'")
    ],
    ["mysql2's message alone", new Error("Duplicate entry '911' for key 'device_phone_unique'")],
    ['a bare string', "Duplicate entry '911' for key 'device_phone_unique'"]
  ])('is a duplicate: %s', (_label, error) => {
    expect(isDuplicateKey(error)).toBe(true);
  });

  it.each([
    [
      'a lock wait whose parameters say "Duplicate entry"',
      oxmysql(["Duplicate entry '1' for key 'x'"], 'Lock wait timeout exceeded')
    ],
    ['another errno', Object.assign(new Error('x'), { errno: 1205 })],
    ['a message that only mentions duplicates', new Error('duplicate entry somewhere')],
    ['nothing at all', undefined]
  ])('is not a duplicate: %s', (_label, error) => {
    expect(isDuplicateKey(error)).toBe(false);
  });
});
