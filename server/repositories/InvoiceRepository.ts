// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import type { Invoice } from '@mica/shared/types';

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
export class InvoiceRepository extends SchemaRepository<Invoice> {
  /** Open invoices for one citizen that have not lapsed, newest first. */
  async findOpen(citizenid: string, now: number): Promise<Invoice[]> {
    return await Database.query<Invoice[]>(
      `SELECT * FROM \`mica_invoices\`
        WHERE \`citizenid\` = ? AND \`status\` = 'active' AND \`expires_at\` > ?
        ORDER BY \`id\` DESC`,
      [citizenid, now]
    );
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
