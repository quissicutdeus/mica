import './inProcess/facets/keybinds';
import { guarded } from './guard';
export type { KeybindGroup } from './inProcess/facets/keybinds';

/**
 * OS Service Hook for keyboard shortcuts.
 *
 * An app claims an action while it is mounted and the shell routes the key to it, so
 * `App.svelte` never needs to know which apps exist or what keys they want — the same
 * reason every other OS service goes through the SDK.
 *
 * ```ts
 * const { onKeybind } = useKeybinds();
 * onKeybind('shutter', takePhoto);
 * ```
 */
export function useKeybinds() {
  return guarded('useKeybinds').facets.keybinds();
}
