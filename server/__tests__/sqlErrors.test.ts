// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { isDuplicateKey, reasonOf, traceOf } from '../lib/sqlErrors';

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

/**
 * MICA-433: a duplicate-key reason keeps the key and drops the value. The value is whatever
 * collided — a citizenid, a phone number, a phone id — and a reason goes into log lines.
 */
describe('a duplicate entry, as a reason', () => {
  const viaOxmysql = (driver: string) =>
    new Error(
      `mica was unable to execute a query!\nINSERT INTO \`mica_phone_numbers\` …\n` +
        `["CID_A","5550101"]\n${driver}`
    );

  it('drops the value and keeps the key, in both driver shapes', () => {
    const line = "Duplicate entry 'char1:3f9a2c7e5b1d' for key 'mica_phone_numbers.citizenid'";
    expect(reasonOf(viaOxmysql(line))).toBe(
      "Duplicate entry '…' for key 'mica_phone_numbers.citizenid'"
    );
    expect(
      reasonOf(
        Object.assign(new Error("Duplicate entry '5550101' for key 'number'"), {
          errno: 1062
        })
      )
    ).toBe("Duplicate entry '…' for key 'number'");
  });

  it('drops a value that holds a quote, and a composite one', () => {
    expect(reasonOf(new Error("Duplicate entry 'O'Brien-7' for key 'handle'"))).toBe(
      "Duplicate entry '…' for key 'handle'"
    );
    expect(reasonOf(new Error("Duplicate entry 'CIT_A|CIT_B' for key 'pair_key_unique'"))).toBe(
      "Duplicate entry '…' for key 'pair_key_unique'"
    );
  });

  it('still reads as a duplicate, and traceOf carries the redaction', () => {
    const error = viaOxmysql("Duplicate entry 'CID_A' for key 'citizenid'");
    expect(isDuplicateKey(error)).toBe(true);
    expect(traceOf(error)).not.toContain('CID_A');
  });

  it('leaves every other reason as it was — the positive twin', () => {
    expect(reasonOf(new Error('Lost connection to MySQL server'))).toBe(
      'Lost connection to MySQL server'
    );
  });
});
