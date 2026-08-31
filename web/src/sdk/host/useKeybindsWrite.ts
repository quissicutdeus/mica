import { guarded } from './guard';

/**
 * OS Service Hook for rebinding the phone's keyboard shortcuts (MICA-127) — setting or
 * resetting a key. Separate from `useKeybinds()`, which only lets an app claim an action
 * for itself and read the current bindings.
 */
export function useKeybindsWrite() {
  return guarded('useKeybindsWrite').facets.keybindsWrite();
}
