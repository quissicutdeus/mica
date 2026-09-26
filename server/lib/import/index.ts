// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Ledger, Resolver, type ImportContext } from './context';
import { importLbPhone, lbNumberOwners } from './lbPhone';
import { importNpwd } from './npwd';
import { importQbPhone } from './qbPhone';
import type { ImportReport, ImportSource, TableReport } from './report';

export type { ImportReport, ImportSource } from './report';
export { IMPORT_SOURCES, formatReport } from './report';

/**
 * Bring a previous phone's data into micaOS (MICA-233): contacts, conversations and messages,
 * gallery images, and posts, read in place from the same database.
 *
 * A dry run (`apply: false`) reads everything and resolves every owner, and writes nothing —
 * not even a phone for a citizen who has none. `apply: true` writes, and records each row it
 * writes in `mica_import_ledger`, so running it again writes nothing new.
 */
export const runImport = async (
  source: ImportSource,
  opts: { apply: boolean }
): Promise<ImportReport> => {
  const apply = opts.apply === true;
  const ctx: ImportContext = {
    source,
    apply,
    ledger: new Ledger(source, apply),
    resolver: new Resolver(source === 'lb-phone' ? lbNumberOwners : undefined)
  };

  let tables: TableReport[];
  switch (source) {
    case 'qb-phone':
      tables = await importQbPhone(ctx);
      break;
    case 'lb-phone':
      tables = await importLbPhone(ctx);
      break;
    case 'npwd':
      tables = await importNpwd(ctx);
      break;
    default:
      throw new Error(`micaimport: '${String(source)}' is not a source this importer reads.`);
  }

  return { source, apply, tables };
};
