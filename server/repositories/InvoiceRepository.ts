// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { openRows } from '../lib/contentCipher';
import type { Invoice } from '@mica/shared/types';

/**
 * The row as the server holds it: the wire `Invoice` plus the two columns no reply carries —
 * the billed player's `citizenid`, and `payee`, the character paid, which is somebody else's
 * citizenid (MICA-433).
 */
export type InvoiceRow = Invoice & { citizenid: string; payee: string | null };

/**
 * What `findOpen` selects, by name rather than `*` (MICA-433): every column of the wire type
 * and nothing else. A `SELECT *` here put the biller's citizenid in `payee` on every row of the
 * billed player's list.
 */
const OPEN_COLUMNS = [
  'id',
  'from_label',
  'amount',
  'memo',
  'society',
  'resource',
  'expires_at',
  'paid_at',
  'status',
  'created_at',
  'updated_at'
]
  .map((column) => `\`${column}\``)
  .join(', ');

/**
 * The three writes an invoice's life needs and the generic path cannot express (MICA-240).
 *
 * All three are **named** methods with the predicate written out, which is what §2.9 asks of a
 * privileged write: `claim` moves a row out of `active` only if it is still there, in one
 * statement, so two taps racing the same invoice cannot both pay it — the second finds no
 * `active` row and is told so. `reopen` is the compensating half for a payment that did not
 * go through after the claim. `expireDue` is the sweep, and is the one write here with no
 * citizen in its predicate, because it is the server's own housekeeping over every row.
 */
export class InvoiceRepository extends SchemaRepository<InvoiceRow> {
  /** Open invoices for one citizen that have not lapsed, newest first. */
  async findOpen(citizenid: string, now: number): Promise<Invoice[]> {
    // `from_label` and `memo` are sealed to the billed player (MICA-432): `citizenid` is read
    // to open them, and dropped again — it is the reader's own, and the list never carried it.
    const rows = openRows(
      'mica_invoices',
      await Database.query<(Invoice & { citizenid: string })[]>(
        `SELECT ${OPEN_COLUMNS}, \`citizenid\` FROM \`mica_invoices\`
          WHERE \`citizenid\` = ? AND \`status\` = 'active' AND \`expires_at\` > ?
          ORDER BY \`id\` DESC`,
        [citizenid, now]
      )
    );
    return rows.map(({ citizenid: _reader, ...invoice }) => invoice as Invoice);
  }

  /**
   * Move one of a citizen's open invoices to a terminal status, answering whether it was
   * still open. The `status = 'active'` predicate is the whole double-pay defence: MySQL runs
   * the statement atomically, so exactly one caller sees `true`.
   */
  async claim(
    id: number,
    citizenid: string,
    status: 'paid' | 'declined',
    paidAt: number | null
  ): Promise<boolean> {
    return await Database.update(
      `UPDATE \`mica_invoices\` SET \`status\` = ?, \`paid_at\` = ?
        WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'active'`,
      [status, paidAt, id, citizenid]
    );
  }

  /** Put a claimed-but-unpaid invoice back, so the player can try again. */
  async reopen(id: number, citizenid: string): Promise<boolean> {
    return await Database.update(
      `UPDATE \`mica_invoices\` SET \`status\` = 'active', \`paid_at\` = NULL
        WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'paid' AND \`paid_at\` IS NULL`,
      [id, citizenid]
    );
  }

  /** Record when a claimed invoice's money landed. `reopen` reads a null here as "it did not". */
  async stampPaid(id: number, citizenid: string, paidAt: number): Promise<boolean> {
    return await Database.update(
      `UPDATE \`mica_invoices\` SET \`paid_at\` = ?
        WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'paid'`,
      [paidAt, id, citizenid]
    );
  }

  /** Every open invoice past its expiry, in one statement. Answers whether any were. */
  async expireDue(now: number): Promise<boolean> {
    return await Database.update(
      `UPDATE \`mica_invoices\` SET \`status\` = 'expired'
        WHERE \`status\` = 'active' AND \`expires_at\` <= ?`,
      [now]
    );
  }
}
