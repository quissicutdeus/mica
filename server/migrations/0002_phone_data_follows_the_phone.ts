// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const PHONES = 'mica_phones';
const NUMBERS = 'mica_phone_numbers';
const CONVERSATIONS = 'mica_messages_conversations';
const PARTICIPANTS = 'mica_messages_participants';

/**
 * The tables whose rows follow the phone (MICA-282), frozen at the moment this shipped.
 *
 * A literal list rather than `declaredServices.filter(deviceOwned)`, for the reason every
 * migration here gives: a migration is frozen when it ships, and a service module whose flags
 * can change out from under it would make a past migration mean something different than what
 * it ran. `docs/schema-and-services.md` has the reasoning behind each entry and each absence.
 */
const DEVICE_TABLES = [
  'mica_contacts',
  'mica_notes',
  'mica_media',
  'mica_lockscreen',
  'mica_settings',
  'mica_notifications',
  'mica_phone_call_log',
  'mica_places',
  'mica_blocklist',
  PARTICIPANTS
] as const;

/**
 * Every unique key that named the citizen and now names the phone: a character with two
 * phones has two passcodes, two themes, two block lists and two memberships in a thread.
 * The new key is added before the old one is dropped, so a failure part-way leaves the old
 * invariant standing for the retry.
 */
const KEY_SWAPS = [
  {
    table: 'mica_lockscreen',
    drop: 'citizenid_unique',
    add: 'phone_id_unique',
    columns: ['phone_id']
  },
  {
    table: 'mica_settings',
    drop: 'citizenid_app_key',
    add: 'phone_app_key',
    columns: ['phone_id', 'app', 'setting_key']
  },
  {
    table: 'mica_blocklist',
    drop: 'citizenid_number_unique',
    add: 'phone_number_unique',
    columns: ['phone_id', 'number']
  },
  {
    table: PARTICIPANTS,
    drop: 'conversation_participant_unique',
    add: 'conversation_phone_unique',
    columns: ['conversation_id', 'phone_id']
  }
] as const;

const hasColumn = async (table: string, column: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(count) > 0;
};

const hasIndex = async (table: string, index: string): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return Number(count) > 0;
};

/**
 * Each citizen's phone for the backfill: their **lowest-id** one.
 *
 * A citizen who already has a phone — minted into an item by MICA-280 since it shipped — keeps
 * it and their rows land on it; a citizen who has none gets one unclaimed phone minted below,
 * which is then their only one. Written once and joined three times, because the three
 * disagreeing about which phone is "the" phone is the whole failure mode.
 */
const CITIZEN_PHONE = `(
  SELECT p.\`citizenid\`, p.\`phone_id\`
    FROM \`${PHONES}\` p
    JOIN (SELECT \`citizenid\`, MIN(\`id\`) AS \`id\` FROM \`${PHONES}\` GROUP BY \`citizenid\`) f
      ON f.\`id\` = p.\`id\`
)`;

/**
 * MICA-282: the phone's data belongs to the phone. Contacts, notes, media, the lock screen,
 * settings, notifications, the call log, saved places, the block list and a thread's
 * membership all gain a `phone_id`, and every existing row is put onto its owner's phone.
 *
 * **The migration cannot mint a phone into an item** — an id lives in inventory metadata,
 * which exists only at runtime — so it mints one *unclaimed* phone per citizen who has rows
 * and no phone yet, and `services/Phones.ts` has the first item that citizen uses adopt it.
 * On a server that can never carry an id, the unclaimed phone is simply the citizen's phone.
 *
 * **The steps, in an order each of which needs the last.**
 *
 * 1. `mica_phones.claimed`, marking every phone that already exists as bound to an item —
 *    all of them were, since until now nothing but `resolvePhone` created one.
 * 2. `phone_id` and its key on every device table, so there is somewhere to write.
 * 3. One unclaimed phone per citizen who owns a row anywhere and has no phone. Minted in
 *    TypeScript with the same `randomBytes(16)` the runtime uses, rather than in SQL: the id
 *    is the same shape either way, and a `SELECT` feeding an `INSERT` into the table it
 *    reads is exactly the statement MySQL refuses (ER 1093) or materialises unpredictably.
 * 4. Every device row with no phone yet is put on its citizen's phone. `updated_at` is
 *    pinned throughout, so the restore window and the inbox order are what they were.
 * 5. Each citizen's legacy number (MICA-284, `phone_id` NULL) is attached to that phone,
 *    where the phone has no number yet — one phone, one number, which `phone_id_unique`
 *    enforces and this respects rather than trips over.
 * 6. A 1:1 thread's `participant_a`/`participant_b` become the two phones rather than the
 *    two citizens, so the generated `pair_key` is a pair of phones: one person's two phones
 *    can each hold a thread with the same contact. Each citizen maps to exactly one phone
 *    here, so no two pairs collapse into one.
 * 7. The four unique keys that named the citizen are replaced by ones naming the phone.
 *
 * **Safe to run twice.** Every DDL step asks `information_schema` first; the backfills only
 * touch rows still holding NULL; the pair rewrite only matches a value that is still a
 * citizenid; the mint skips anyone who has a phone.
 */
export const migration: Migration = {
  id: '0002_phone_data_follows_the_phone',
  description:
    `gives ${DEVICE_TABLES.length} device-owned tables a phone_id and puts every existing row ` +
    `on its owner's phone, minting one unclaimed phone per citizen who had none; attaches ` +
    `legacy numbers, re-keys 1:1 threads onto phones, and swaps four per-citizen unique keys ` +
    `for per-phone ones`,
  up: async () => {
    // 1. Which phones are already on an item.
    if (!(await hasColumn(PHONES, 'claimed'))) {
      await Database.query(
        `ALTER TABLE \`${PHONES}\` ADD COLUMN \`claimed\` tinyint(1) NOT NULL DEFAULT 0`,
        []
      );
      // Every row that exists was minted into an item by resolvePhone; nothing else made one.
      await Database.query(
        `UPDATE \`${PHONES}\` SET \`claimed\` = 1, \`updated_at\` = \`updated_at\``,
        []
      );
    }

    // 2. Somewhere to write.
    for (const table of DEVICE_TABLES) {
      if (!(await hasColumn(table, 'phone_id'))) {
        await Database.query(
          `ALTER TABLE \`${table}\` ADD COLUMN \`phone_id\` varchar(32) DEFAULT NULL`,
          []
        );
      }
      if (!(await hasIndex(table, 'phone_id'))) {
        await Database.query(`ALTER TABLE \`${table}\` ADD KEY \`phone_id\` (\`phone_id\`)`, []);
      }
    }

    // 3. A phone for everyone who owns something and has none.
    const owners = [...DEVICE_TABLES, NUMBERS]
      .map((table) => `SELECT \`citizenid\` FROM \`${table}\``)
      .join(' UNION ');
    const unphoned = await Database.query<{ citizenid: string }[]>(
      `SELECT DISTINCT o.\`citizenid\` FROM (${owners}) o
        WHERE o.\`citizenid\` IS NOT NULL AND o.\`citizenid\` <> ''
          AND NOT EXISTS (SELECT 1 FROM \`${PHONES}\` p WHERE p.\`citizenid\` = o.\`citizenid\`)`,
      []
    );
    for (const { citizenid } of unphoned ?? []) {
      await Database.query(
        `INSERT INTO \`${PHONES}\` (\`citizenid\`, \`phone_id\`, \`claimed\`) VALUES (?, ?, 0)`,
        [citizenid, randomBytes(16).toString('hex')]
      );
    }
    console.log(
      `[mica] ${PHONES}: minted ${unphoned?.length ?? 0} unclaimed phone(s) for citizens who ` +
        `had rows but no phone. Each is adopted by the first phone item its owner uses.`
    );

    // 4. Every row onto its owner's phone.
    for (const table of DEVICE_TABLES) {
      await Database.query(
        `UPDATE \`${table}\` t
           JOIN ${CITIZEN_PHONE} ph ON ph.\`citizenid\` = t.\`citizenid\`
            SET t.\`phone_id\` = ph.\`phone_id\`, t.\`updated_at\` = t.\`updated_at\`
          WHERE t.\`phone_id\` IS NULL`,
        []
      );
    }

    // 5. Legacy numbers onto the phone — one per phone, the lowest-id legacy row per citizen.
    await Database.query(
      `UPDATE \`${NUMBERS}\` n
         JOIN (SELECT \`citizenid\`, MIN(\`id\`) AS \`id\` FROM \`${NUMBERS}\`
                WHERE \`phone_id\` IS NULL GROUP BY \`citizenid\`) first ON first.\`id\` = n.\`id\`
         JOIN ${CITIZEN_PHONE} ph ON ph.\`citizenid\` = n.\`citizenid\`
         LEFT JOIN (SELECT \`phone_id\` FROM \`${NUMBERS}\`
                     WHERE \`phone_id\` IS NOT NULL GROUP BY \`phone_id\`) taken
           ON taken.\`phone_id\` = ph.\`phone_id\`
          SET n.\`phone_id\` = ph.\`phone_id\`, n.\`updated_at\` = n.\`updated_at\`
        WHERE n.\`phone_id\` IS NULL AND taken.\`phone_id\` IS NULL`,
      []
    );

    // 6. A pair is two phones. Only a value that is still a citizenid matches the map.
    for (const side of ['participant_a', 'participant_b'] as const) {
      await Database.query(
        `UPDATE \`${CONVERSATIONS}\` c
           JOIN ${CITIZEN_PHONE} ph ON ph.\`citizenid\` = c.\`${side}\`
            SET c.\`${side}\` = ph.\`phone_id\`, c.\`updated_at\` = c.\`updated_at\``,
        []
      );
    }

    // 7. The keys that named the citizen now name the phone. Add, then drop.
    for (const swap of KEY_SWAPS) {
      if (!(await hasIndex(swap.table, swap.add))) {
        const list = swap.columns.map((column) => `\`${column}\``).join(', ');
        await Database.query(
          `ALTER TABLE \`${swap.table}\` ADD UNIQUE KEY \`${swap.add}\` (${list})`,
          []
        );
      }
      if (await hasIndex(swap.table, swap.drop)) {
        await Database.query(`ALTER TABLE \`${swap.table}\` DROP KEY \`${swap.drop}\``, []);
      }
    }
  }
};
