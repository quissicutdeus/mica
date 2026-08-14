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
