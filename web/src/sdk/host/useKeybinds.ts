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
 *
 * Claiming an action for your own app this way needs nothing more — `onKeybind`, `bindings`,
 * `groups` and `findConflict` are all read-only. Rebinding a key or wiping every override is
 * `useKeybindsWrite` (MICA-127); only Settings' Shortcuts screen has any business there.
 */
export function useKeybinds() {
  return guarded('useKeybinds').facets.keybinds();
}
