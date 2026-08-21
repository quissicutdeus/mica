import './inProcess/facets/theme';
import { guarded } from './guard';

/**
 * Read and change the phone's color theme.
 */
export function useTheme() {
  return guarded('useTheme').facets.theme();
}

/** @public — SDK surface for add-ons; no in-repo app needs to name it. */
export type { ThemeState, ThemeMode } from './inProcess/facets/theme';
