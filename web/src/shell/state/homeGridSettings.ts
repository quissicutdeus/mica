import { usePersisted } from '../../sdk/hooks/usePersisted';

export const HOME_GRID_COLUMNS_DEFAULT = 4;
export const HOME_GRID_ROWS_DEFAULT = 5;
export const HOME_GRID_COLUMNS_MIN = 3;
export const HOME_GRID_COLUMNS_MAX = 5;
export const HOME_GRID_ROWS_MIN = 4;
export const HOME_GRID_ROWS_MAX = 6;

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const clampColumns = (value: unknown): number =>
  clamp(value, HOME_GRID_COLUMNS_MIN, HOME_GRID_COLUMNS_MAX, HOME_GRID_COLUMNS_DEFAULT);

export const clampRows = (value: unknown): number =>
  clamp(value, HOME_GRID_ROWS_MIN, HOME_GRID_ROWS_MAX, HOME_GRID_ROWS_DEFAULT);

export const homeGridColumns = usePersisted<number>(
  'settings',
  'homeGridColumns',
  HOME_GRID_COLUMNS_DEFAULT,
  { sanitize: clampColumns }
);

export const homeGridRows = usePersisted<number>(
  'settings',
  'homeGridRows',
  HOME_GRID_ROWS_DEFAULT,
  {
    sanitize: clampRows
  }
);
