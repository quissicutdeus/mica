// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import { IMPORT_SOURCES, formatReport, runImport, type ImportSource } from '../lib/import';
import { LEDGER_TABLE } from '../lib/import/context';
import { notifyPlayer } from '../lib/shell';

/**
 * `micaimport` (MICA-233): bring a qb-phone, lb-phone or NPWD install's data into micaOS.
 *
 * The ledger is declared here, as a service with no actions: `write: 'server'` turns the
 * generic create and update off, and the options below turn off the rest, so the declaration
 * yields a table and nothing a client can reach. It is what makes a second `--apply` write
 * nothing: every row the importer writes is recorded as (source, source table, source key) →
 * the micaOS row it became, and the unique key makes a double record fail loudly rather than
 * quietly write twice.
 */
interface LedgerRow {
  id: number;
  citizenid: string;
  source: string;
  source_table: string;
  source_key: string;
  target_table: string;
  target_id: number;
}

defineService<LedgerRow>({
  id: 'importledger',
  table: LEDGER_TABLE,
  access: { read: 'owner', write: 'server' },
  schema: {
    source: { type: 'string', length: 16, notNull: true, clientWritable: false },
    source_table: { type: 'string', length: 64, notNull: true, clientWritable: false },
    // Raw when it fits, `sha1:<hex>` when it does not — see `ledgerKey`.
    source_key: { type: 'string', length: 64, notNull: true, clientWritable: false },
    target_table: { type: 'string', length: 64, notNull: true, clientWritable: false },
    target_id: { type: 'int', notNull: true, clientWritable: false }
  },
  indexes: [
    {
      name: 'source_row_unique',
      columns: ['source', 'source_table', 'source_key'],
      unique: true
    }
  ],
  options: { disableGet: true, disableDelete: true }
});

let running = false;

/**
 * `micaimport <qb-phone|lb-phone|npwd> [--apply]`.
 *
 * **Console only, the gate `micaschema apply` carries**: an import writes rows into every
 * player's phone at once, and the console is the one place that can take a backup first.
 * Nobody else may run it — an in-game admin included, and the dry run included, so that the
 * command has one rule and an admin cannot probe other players' old data through its counts.
 */
export const runImportCommand = async (source: number, args: string[]): Promise<void> => {
  if (source !== 0) {
    notifyPlayer(source, {
      type: 'error',
      message: 'You do not have permission to use that.',
      key: 'server.schema.noPermission'
    });
    return;
  }

  const which = String(args?.[0] ?? '').toLowerCase() as ImportSource;
  if (!IMPORT_SOURCES.includes(which)) {
    console.log(`[micaimport] usage: micaimport <${IMPORT_SOURCES.join('|')}> [--apply]`);
    return;
  }
  const apply = (args ?? []).slice(1).some((arg) => String(arg).toLowerCase() === '--apply');

  if (running) {
    console.log('[micaimport] an import is already running; wait for it to finish.');
    return;
  }
  running = true;
  try {
    const report = await runImport(which, { apply });
    for (const line of formatReport(report)) console.log(line);
  } catch (error) {
    console.error(
      `[micaimport] ${which} failed part-way; rows already written are in the ledger and a re-run skips them:`,
      error
    );
  } finally {
    running = false;
  }
};

RegisterCommand(
  'micaimport',
  (source: number, args: string[]) => {
    void runImportCommand(source, args);
  },
  false
);
