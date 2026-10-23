// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import { VERSION_REASONS, VERSIONS_TABLE } from '../lib/versions';

/**
 * The version ledger (MICA-430): every value an edit replaced, kept for evidence. Written only by
 * `writeVersioned` (`lib/versions.ts`), in the transaction of the edit itself; read only by staff
 * (`reports:versions`). No player reads it, the owner included, and the privacy export leaves it
 * out (`EXPORT_EXCLUDED`): a player sees the latest version of their own content and nothing
 * before it.
 *
 * `citizenid` is the source row's owner when the value was replaced: what every purge erases a
 * player's versions by (MICA-428), keeping them, hidden, as it keeps the rows themselves.
 */
defineService({
  id: 'versions',
  access: { read: 'owner', write: 'server' },
  table: VERSIONS_TABLE,
  schema: {
    /** The row a version is of: a declared table's name, never a payload's. */
    source_table: { type: 'string', length: 64, notNull: true },
    source_id: { type: 'int', notNull: true },
    /** Who made the edit that replaced it; null for the server or staff. */
    edited_by: { type: 'string', citizenId: true },
    reason: { type: 'enum', values: VERSION_REASONS, notNull: true },
    /**
     * `{"values": {...}, "context": {...}, "written_at": ...}`: the replaced values, the columns
     * a sealed one's authenticated data binds, and when the replaced value had been written. A
     * sealed value is stored exactly as the row held it, so it stays sealed here and opens from
     * the snapshot as it did on the row (MICA-431, MICA-432). Bounded per table at declaration
     * (`assertSnapshotFits`).
     */
    snapshot: { type: 'mediumtext', notNull: true },
    /** The writing transaction's own key, which says whether the write applied. */
    op_key: { type: 'string', length: 32, notNull: true }
  },
  indexes: [
    // A target's versions, oldest first, for the staff read.
    { name: 'source_row', columns: ['source_table', 'source_id', 'id'] },
    { name: 'op_key', columns: ['op_key'] }
    // `citizenid_status`, what every purge finds a player's versions by, comes with the table.
  ],
  options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true }
});
