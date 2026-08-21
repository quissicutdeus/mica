import './inProcess/facets/appLevels';
import { guarded } from './guard';
import type { AppLevelsConfig } from './inProcess/facets/appLevels';
export type { AppLevelsConfig };

/**
 * OS Service Hook for an app's internal levels — the list, the detail, the modal over it.
 */
export function useAppLevels(config: AppLevelsConfig) {
  return guarded('useAppLevels', config.appId).facets.appLevels(config);
}
