// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const TABLE = 'mica_contacts';
const COLUMN = 'ringtone';

/**
 * The width, frozen: `MAX_OWNER_SOUND_ID` when this shipped — `owner:` and a 48-character stem.
 * A migration means what it ran, whatever `shared/ownerConfig.ts` says later.
 */
const WIDTH = 54;

/**
 * MICA-256: a contact's ringtone may be an owner sound, `owner:<stem>`, which the enum of the
 * five built-in ids cannot hold. The column becomes a nullable `varchar(54)`; MySQL and MariaDB
 * both carry an enum's values across a retype to a string as their labels, so every stored
 * ringtone survives and a NULL stays NULL — "use the system ringtone" is not backfilled.
 *
 * The planner cannot do this: a retype is drift it reports and never touches. Safe to run
 * twice — it acts only while the column is still an enum — and a server that never imported
 * the table has nothing to change.
 */
export const migration: Migration = {
  id: '0005_contact_ringtone_holds_owner_sounds',
  description: `${TABLE}.${COLUMN} becomes varchar(${WIDTH}), so it can hold an owner sound id`,
  up: async () => {
    const type = await Database.scalar<string>(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [TABLE, COLUMN]
    );
    if (String(type ?? '').toLowerCase() !== 'enum') return;
    await Database.query(
      `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`${COLUMN}\` varchar(${WIDTH}) DEFAULT NULL`,
      []
    );
  }
};
