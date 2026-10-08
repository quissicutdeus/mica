// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Only ever a name this repo wrote, never anything off the wire — and checked anyway.
 *
 * MySQL cannot parameterize a table or a column name (AGENTS.md §2.9), so every identifier
 * in the sweep is interpolated. All of them come from `defineService` declarations and from
 * frozen literals in `FrameworkBridge`, none of which a payload can reach, so this cannot
 * fire today. It is here because the property "no caller supplies one of these" is invisible
 * at the point where the string is concatenated into a `DELETE`, and the next person to add
 * a parameter to `sweepOrphanedRows` will read that line, not this argument.
 */
export const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const identifier = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `orphanSweep: refusing to build SQL from ${what} '${String(value)}'. Table and column ` +
        'names are interpolated because MySQL cannot bind them, so only a plain identifier ' +
        'this repo declared may reach here.'
    );
  }
  return value;
};

/** SQL with its parameters in order. */
export interface Clause {
  sql: string;
  params: unknown[];
}
