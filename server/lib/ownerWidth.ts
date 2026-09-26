// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { citizenIdWidth } from '@mica/shared/framework';

/**
 * Which schema this server runs, for the two runtime readers of a citizenid column's width
 * (MICA-289): the write guard in `Repository` and the planner behind `micaschema`.
 *
 * `true` when rows hang off `players(citizenid)` (qb, `mica.sql`), `false` when they do not
 * (ESX and standalone, `mica.esx.sql`), `null` while the framework is not known yet — the
 * same third state `FrameworkBridge.detectFramework` keeps as `unknown`.
 *
 * A seam rather than an import of `FrameworkBridge`, because `Repository` sits under every
 * service and most suites mock the bridge with only the methods they use: `FrameworkBridge`
 * installs the real answer at import, and anything that never loads it gets `null`.
 */
let resolveOwnerTable: () => boolean | null = () => null;

export const setOwnerTableResolver = (resolver: () => boolean | null): void => {
  resolveOwnerTable = resolver;
};

export const ownerTableKnown = (): boolean | null => resolveOwnerTable();

/**
 * The width a citizenid column has on this server, and the **narrowest** one while the
 * framework is unknown.
 *
 * Narrowest because the write guard is the only thing between a value and the column for the
 * two columns it sees: `payee` and `target_author` (the implicit `citizenid` is never a
 * client-writable field, and child tables have no rules). `target_author` comes from a stored
 * row, but `payee` is whatever string the resource calling `SendInvoice` passed — nothing
 * resolves it against a character. Falling back to 60 would let a 51–60 character payee reach
 * a qb `varchar(50)` inside the boot window, where strict mode refuses it opaquely and a
 * permissive `sql_mode` truncates it into a payee nobody is. Falling back to 50 refuses it
 * loudly instead, and on ESX costs only a write made before the framework has started.
 */
export const citizenIdColumnWidth = (): number => {
  const ownerTable = resolveOwnerTable();
  return citizenIdWidth(ownerTable ?? true);
};
