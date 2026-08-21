import type { Writable } from 'svelte/store';
import './inProcess/facets/persisted';
import { guarded } from './guard';
import type { PersistedOptions } from './inProcess/facets/persisted';
export type { PersistedOptions };

/**
 * A writable store that survives a reload.
 *
 * `useStorage` is imperative — `getItem`/`setItem` — so every preference, draft and high
 * score was the same hand-written pair: read once at init, write on every change. The
 * shell had already written it by hand for `volumeStep`, sanitizer and all, which is the
 * signal that it belongs in the SDK rather than in each app.
 *
 * Reads are namespaced per app by `useStorage`, so two apps may use the same key.
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
