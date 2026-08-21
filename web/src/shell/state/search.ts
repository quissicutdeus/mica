import { writable, get } from 'svelte/store';
import { registerHandler } from './keybinds';

/**
 * Home-screen search: whether the bar has expanded to the full-screen results sheet.
 *
 * Deliberately a sibling of `appDrawer.ts` rather than a mode inside it. The two open the
 * same way and share the same drag machinery, but they are opposites in what they contain
 * (every app, always, versus whatever matches right now) and either one being open must
 * close the other — a single store could not express "closed" for one and "open" for the
 * other at the same time without a mode enum that every consumer would then have to read.
 */
export const isSearchOpen = writable<boolean>(false);

/** 0 (closed) .. 1 (open). Mirrors `drawerDragProgress` — see `shade.ts` for the rationale. */
export const searchDragProgress = writable<number>(0);

export type SearchDragPhase = 'idle' | 'dragging' | 'settling';
export const searchDragPhase = writable<SearchDragPhase>('idle');

/** What is currently typed. Lives here, not in the component, so closing can clear it. */
export const searchQuery = writable<string>('');

let unregisterBack: (() => void) | null = null;

export function openSearch(): void {
  if (get(isSearchOpen)) return;
  isSearchOpen.set(true);

  if (!unregisterBack) {
    unregisterBack = registerHandler('back', () => {
      closeSearch();
    });
  }
}

export function closeSearch(): void {
  isSearchOpen.set(false);
  searchDragProgress.set(0);
  searchDragPhase.set('idle');
  // The query is state about one visit, not a setting: reopening the bar should offer an
  // empty field rather than yesterday's search and its stale result list.
  searchQuery.set('');
  if (unregisterBack) {
    unregisterBack();
    unregisterBack = null;
  }
}
