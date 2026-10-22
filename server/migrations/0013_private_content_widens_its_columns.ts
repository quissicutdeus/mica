// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * The widths, frozen: each `varchar`'s plaintext bound sealed at four bytes a character with
 * the longest key id, as `sealedLengthForChars` computed it when this shipped. A migration
 * means what it ran, whatever the declarations say later. `mica_notes.content` keeps its
 * type, as 0007 left `mica_mail.content`: its plaintext bound came down instead.
 */
const TABLES: readonly {
  table: string;
  columns: readonly { column: string; width: number; nullable: boolean }[];
}[] = [
  {
    table: 'mica_notes',
    columns: [{ column: 'title', width: 1422, nullable: true }]
  },
  {
    table: 'mica_contacts',
    columns: [
      { column: 'firstname', width: 326, nullable: false },
      { column: 'lastname', width: 326, nullable: true },
      { column: 'email', width: 594, nullable: true }
    ]
  },
  {
    table: 'mica_phone_call_log',
    columns: [{ column: 'number', width: 166, nullable: false }]
  },
  {
    table: 'mica_places',
    columns: [
      { column: 'name', width: 594, nullable: false },
      { column: 'street_label', width: 1422, nullable: true }
    ]
  },
  {
    table: 'mica_media',
    columns: [{ column: 'alt_text', width: 1422, nullable: true }]
  },
  {
    table: 'mica_notifications',
    columns: [
      { column: 'title', width: 486, nullable: false },
      { column: 'body', width: 1422, nullable: false }
    ]
  },
  {
    table: 'mica_reports',
    columns: [{ column: 'note', width: 2726, nullable: true }]
  },
  {
    table: 'mica_darkchat_messages',
    columns: [{ column: 'bot_alias', width: 190, nullable: true }]
  }
];

/** A character set or collation name, as information_schema spells one, and nothing else. */
const CHARSET_NAME = /^[A-Za-z0-9_]+$/;

/** InnoDB keeps a one-byte length prefix below this many bytes, and a two-byte one from it. */
const TWO_BYTE_PREFIX = 256;

interface Current {
  type: string;
  chars: number | string | null;
  octets: number | string | null;
  charset: string | null;
  collation: string | null;
}

/**
 * MICA-431: a phone's own private content is sealed at rest — a note, a contact's name and
 * email, a call's number, a saved place, a photo's alt text, a notification, a report's note,
 * a Dark Chat export's alias — and a sealed value is longer than the text in it. Each column
 * becomes as wide as its declared plaintext bound needs once sealed.
 *
 * **In place where the engine can, and said where it cannot.** 0007 refused anything but
 * `ALGORITHM=INPLACE`, because both its columns already had a two-byte length prefix. Several
 * here do not: `varchar(50)` in utf8mb4 is 200 bytes, a one-byte prefix, and crossing to 256
 * bytes or more rewrites every row whatever the statement asks for. Those tables are altered with `ALGORITHM=COPY, LOCK=SHARED` — rows stay readable
 * while it runs, writes wait — and the console says which before it starts. Which one a column
 * needs is read from its own byte width, not assumed, so a table an owner moved to utf8mb3
 * gets the algorithm its own prefix allows. Every other table is altered in place, as 0007 was,
 * and refuses rather than quietly copying.
 *
 * **One statement a table**, so a table with three columns to widen is copied once, not three
 * times.
 *
 * **The column's own character set and collation, restated**, for 0007's reason: a widening
 * must not also be a re-collation.
 *
 * Safe to run twice — a column is altered only while it is still narrower than its width — and a server that never created a table has nothing to change.
 */
export const migration: Migration = {
  id: '0013_private_content_widens_its_columns',
  description: "a phone's private content columns widen to hold their sealed form",
  up: async () => {
    for (const { table, columns } of TABLES) {
      const changes: string[] = [];
      let copy = false;
      for (const { column, width, nullable } of columns) {
        const current = await Database.single<Current>(
          `SELECT DATA_TYPE AS \`type\`, CHARACTER_MAXIMUM_LENGTH AS \`chars\`,
                  CHARACTER_OCTET_LENGTH AS \`octets\`,
                  CHARACTER_SET_NAME AS \`charset\`, COLLATION_NAME AS \`collation\`
             FROM information_schema.COLUMNS
            WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
          [table, column]
        );
        if (!current) continue;
        if (String(current.type).toLowerCase() !== 'varchar') continue;
        const chars = Number(current.chars);
        if (chars >= width) continue;
        const octets = Number(current.octets);
        const perChar = chars > 0 ? octets / chars : 4;
        if (octets < TWO_BYTE_PREFIX && width * perChar >= TWO_BYTE_PREFIX) copy = true;
        const charset = String(current.charset ?? '');
        const collation = String(current.collation ?? '');
        if (!CHARSET_NAME.test(charset) || !CHARSET_NAME.test(collation)) {
          throw new Error(
            `${table}.${column} reports character set '${charset}' and collation ` +
              `'${collation}', which this migration will not restate. Widen it by hand to ` +
              `varchar(${width}).`
          );
        }
        changes.push(
          `MODIFY COLUMN \`${column}\` varchar(${width}) ` +
            `CHARACTER SET ${charset} COLLATE ${collation} ` +
            (nullable ? 'DEFAULT NULL' : 'NOT NULL')
        );
      }
      if (changes.length === 0) continue;
      if (copy) {
        console.log(
          `[micaschema] ${table}: copying the table to widen it (MICA-431); its rows stay ` +
            'readable meanwhile, and writes to it wait until it is done.'
        );
      }
      await Database.query(
        `ALTER TABLE \`${table}\` ${changes.join(', ')}, ` +
          (copy ? 'ALGORITHM=COPY, LOCK=SHARED' : 'ALGORITHM=INPLACE, LOCK=NONE'),
        []
      );
    }
  }
};
