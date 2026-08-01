import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { isBrowser } from '../lib/isBrowser';

/**
 * Whether the player holds an admin ace, as decided by the server.
 *
 * One store rather than each screen asking for itself. Settings already fetched this
 * privately to gate Developer Tools, and the home screen needs the same answer to
 * decide whether the Administration app exists — two copies of one fact drift, and the
 * whole point of asking the server is that there is a single authority.
 *
 * It decides what the UI *shows* and nothing more. Every privileged action is checked
 * again server-side, because a NUI request is not proof of intent (AGENTS.md §2.9).
 *
 * A plain browser has no ace list and no server to ask, so it stands in as allowed.
 */
export const isAdmin = writable(isBrowser());

let asked = false;

/** Ask once per session. Safe to call from anywhere that needs the answer. */
export const refreshAdmin = async (): Promise<void> => {
  if (isBrowser() || asked) return;
  asked = true;
  try {
    const res = await fetchNui<{ isAdmin?: boolean }>('checkAdmin');
    isAdmin.set(res?.isAdmin === true);
  } catch {
    isAdmin.set(false);
  }
};
