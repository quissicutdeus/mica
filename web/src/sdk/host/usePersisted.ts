import type { Writable } from 'svelte/store';
import './inProcess/facets/persisted';
import { guarded } from './guard';
import type { PersistedOptions } from './inProcess/facets/persisted';
export type { PersistedOptions };

/**
 * A writable store that survives a reload.
 *
 * ```ts
 * const highScore = usePersisted('snake', 'highScore', 0);
 * $highScore = Math.max($highScore, score);
 * ```
 */
export function usePersisted<T>(
  appId: string,
  key: string,
  initial: T,
  options: PersistedOptions<T> = {}
): Writable<T> {
  return guarded('usePersisted', appId).facets.persisted(appId, key, initial, options);
}
