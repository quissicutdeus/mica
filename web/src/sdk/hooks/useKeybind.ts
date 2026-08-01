import { onDestroy } from 'svelte';
import {
  bindings,
  registerHandler,
  resetBindings,
  setBinding,
  currentOverrides
} from '../../store/keybinds';
import { PHONE_SCOPE_ACTIONS, conflictsWith, findAction } from '@shared/keybinds';

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
  return {
    /** Claim an action for as long as this component is mounted. */
    onKeybind: (actionId: string, handler: () => void) => {
      const release = registerHandler(actionId, handler);
      try {
        onDestroy(release);
      } catch {
        // Called outside a component lifecycle; the caller owns cleanup.
      }
      return release;
    },

    /** Live map of actionId -> bound key. */
    bindings,

    /** Everything configurable from gPhone's own Shortcuts screen. */
    actions: PHONE_SCOPE_ACTIONS,

    setBinding,
    resetBindings,

    /**
     * The action already using this key in the same context, if any. Two actions may
     * share a key when their contexts are disjoint — Enter is both Answer Call and the
     * camera shutter, and only one is ever eligible.
     */
    findConflict: (actionId: string, key: string) => {
      const action = findAction(actionId);
      if (!action) return undefined;
      return conflictsWith(action, key, currentOverrides());
    }
  };
}
