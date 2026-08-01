import { writable } from 'svelte/store';

/**
 * Whether Developer Tools are currently revealed.
 *
 * Module scope, not component state and **not** persisted. Both matter:
 *
 * - Module scope, because `App.svelte` re-keys on `currentApp.name`, so the Settings
 *   component is destroyed the moment you leave it. Component state would drop the
 *   unlock on the first app switch.
 * - Not persisted, because the point of the ten taps is that Developer Tools are not
 *   there until you deliberately reveal them. A stored flag makes them permanent after
 *   one unlock, which is how they ended up visible on a fresh phone.
 *
 * Cleared when the phone closes, so every session earns it again.
 */
export const devToolsUnlocked = writable(false);

export const lockDevTools = () => devToolsUnlocked.set(false);
