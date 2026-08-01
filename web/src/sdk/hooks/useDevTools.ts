import { devToolsUnlocked, lockDevTools } from '../../store/devtools';

/**
 * OS Service Hook for the Developer Tools reveal.
 *
 * Settings was importing `../../store/devtools` directly, which §2.7 prohibits outright
 * — reaching into a shell store is the exact thing that stops an app working as a
 * standalone add-on. It is the only store an app module was still reaching for.
 *
 * The flag is session-scoped and not persisted; see `store/devtools.ts` for why.
 */
export function useDevTools() {
  return {
    /** Whether the Developer Tools group is currently revealed. */
    devToolsUnlocked,
    unlock: () => devToolsUnlocked.set(true),
    lock: () => lockDevTools()
  };
}
