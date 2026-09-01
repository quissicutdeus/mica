// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import {
  clampColumns,
  clampRows,
  HOME_GRID_COLUMNS_DEFAULT,
  HOME_GRID_COLUMNS_MAX,
  HOME_GRID_COLUMNS_MIN,
  HOME_GRID_ROWS_DEFAULT,
  HOME_GRID_ROWS_MAX,
  HOME_GRID_ROWS_MIN
} from './homeGridSettings';

describe('Home grid settings clamping', () => {
  it('clamps columns into [3, 5]', () => {
    expect(clampColumns(2)).toBe(HOME_GRID_COLUMNS_MIN);
    expect(clampColumns(6)).toBe(HOME_GRID_COLUMNS_MAX);
    expect(clampColumns(4)).toBe(4);
  });

  it('clamps rows into [4, 6]', () => {
    expect(clampRows(1)).toBe(HOME_GRID_ROWS_MIN);
    expect(clampRows(99)).toBe(HOME_GRID_ROWS_MAX);
    expect(clampRows(5)).toBe(5);
  });

  it('falls back to the default for non-numeric garbage', () => {
    expect(clampColumns('nope')).toBe(HOME_GRID_COLUMNS_DEFAULT);
    expect(clampRows(undefined)).toBe(HOME_GRID_ROWS_DEFAULT);
    expect(clampRows(NaN)).toBe(HOME_GRID_ROWS_DEFAULT);
  });

  it('clamps rather than defaulting a finite out-of-range number, including null (Number(null) === 0)', () => {
    expect(clampColumns(null)).toBe(HOME_GRID_COLUMNS_MIN);
  });

  it('rounds a fractional value', () => {
    expect(clampColumns(3.6)).toBe(4);
  });
});
