import './inProcess/facets/keybinds';
import { guarded } from './guard';
export type { KeybindGroup } from './inProcess/facets/keybinds';

/**
 * OS Service Hook for keyboard shortcuts.
 */
export function useKeybinds() {
  return guarded('useKeybinds').facets.keybinds();
}
