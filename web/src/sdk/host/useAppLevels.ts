import './inProcess/facets/appLevels';
import { guarded } from './guard';
import type { AppLevelsConfig } from './inProcess/facets/appLevels';
export type { AppLevelsConfig };

/**
 * OS Service Hook for an app's internal levels — the list, the detail, the modal over it.
 *
 * Two things have to happen for back to work inside an app, and they are independent, so
 * either can be forgotten and one usually was:
 *
 * 1. A ladder that closes the deepest open level instead of leaving.
 * 2. Claiming the `back` action, because the shell owns Backspace and pre-empts anything
 *    wired only to `<Screen onback>`.
 *
 * Notes and Contacts each shipped step 1 without step 2, so Backspace left the app from a
 * detail view. Here they are the same call: there is no way to describe the levels and
 * not claim the key.
 *
 * Levels are given deepest first and are read when back is pressed, not when this is
 * called, so `open` and `close` see current state. `close` should undo only its own
 * level — Messages reset twelve fields from one rung and lost the conversation list's
 * scroll position doing it.
 *
 * ```ts
 * const app = useAppLevels({
 *   appId: 'notes',
 *   title: 'Notes',
 *   onback,
 *   levels: [
 *     { open: () => isEditing, close: () => (isEditing = false), title: 'Edit Note' },
 *     { open: () => !!selected, close: () => (selected = null), title: () => selected!.title }
 *   ]
 * });
 * ```
 *
 * `<Screen title={app.title} onback={app.back}>` then needs nothing else.
 */
export function useAppLevels(config: AppLevelsConfig) {
  return guarded('useAppLevels', config.appId).facets.appLevels(config);
}
