import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { derived, get } from 'svelte/store';
import {
  allPhoneActions,
  bindings,
  registerHandler,
  resetBindings,
  setBinding,
  currentOverrides,
  type ResolvedKeybindAction
} from '../../../../shell/state/keybinds';
import { conflictsWith, findAction } from '@shared/keybinds';

export interface KeybindGroup {
  ownerId: string;
  ownerLabel: string;
  actions: ResolvedKeybindAction[];
}

/** Core's group renders without picking it out of the pack — it's the phone's own list. */
const CORE_OWNER_ID = 'core';

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
export function keybinds() {
  return {
    /**
     * Claim an action for as long as this component is mounted.
     *
     * Pass `appId` for anything an app claims. Apps are resident, so the claim outlives
     * the app being on screen, and without an owner the dispatcher hands the action to
     * whichever app registered last — see the registry note in `shell/state/keybinds.ts`.
     * Only actions carrying their own `when: 'app:…'` context are safe without it, and
     * naming the app costs nothing either way.
     */
    onKeybind: (actionId: string, handler: () => void, appId?: string) => {
      const release = registerHandler(actionId, handler, appId?.toLowerCase());
      try {
        onDestroy(release);
      } catch {
        // Called outside a component lifecycle; the caller owns cleanup.
      }
      return release;
    },

    /** Live map of actionId -> bound key. */
    bindings,

    /**
     * Everything configurable from gPhone's own Shortcuts screen, grouped by owner.
     *
     * Core first (`ownerId: 'core'`), then one group per installed app that declares its
     * own `keybinds`, sorted alphabetically by `ownerLabel`. An app with no declared
     * keybinds contributes no group at all, rather than an empty one.
     */
    groups: derived(allPhoneActions, ($actions): KeybindGroup[] => {
      const byOwner = new Map<string, KeybindGroup>();
      for (const action of $actions) {
        let group = byOwner.get(action.ownerId);
        if (!group) {
          group = { ownerId: action.ownerId, ownerLabel: action.ownerLabel, actions: [] };
          byOwner.set(action.ownerId, group);
        }
        group.actions.push(action);
      }

      const core = byOwner.get(CORE_OWNER_ID);
      const appGroups = [...byOwner.values()]
        .filter((g) => g.ownerId !== CORE_OWNER_ID)
        .sort((a, b) => a.ownerLabel.localeCompare(b.ownerLabel));

      return core ? [core, ...appGroups] : appGroups;
    }),

    setBinding,
    resetBindings,

    /**
     * The action already using this key in the same context, if any. Two actions may
     * share a key when their contexts are disjoint — Enter is both Answer Call and the
     * camera shutter, and only one is ever eligible.
     */
    findConflict: (actionId: string, key: string) => {
      const action = findAction(actionId) ?? get(allPhoneActions).find((a) => a.id === actionId);
      if (!action) return undefined;
      return conflictsWith(action, key, currentOverrides(), get(allPhoneActions));
    }
  };
}

registerFacet('keybinds', keybinds);
