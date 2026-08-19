import { writable, get } from 'svelte/store';
import { registerHandler } from './keybinds';
import { cancelIconDrag } from './iconDrag';
import { markAppDrawerHintSeen } from './onboarding';

export const isDrawerOpen = writable<boolean>(false);

/** 0 (closed) .. 1 (open). Mirrors `shadeDragProgress` — see `shade.ts` for the rationale. */
export const drawerDragProgress = writable<number>(0);

export type DrawerDragPhase = 'idle' | 'dragging' | 'settling';
export const drawerDragPhase = writable<DrawerDragPhase>('idle');

let unregisterBack: (() => void) | null = null;

export function openDrawer(): void {
  if (get(isDrawerOpen)) return;
  isDrawerOpen.set(true);
  markAppDrawerHintSeen();

  if (!unregisterBack) {
    unregisterBack = registerHandler('back', () => {
      closeDrawer();
    });
  }
}

export function closeDrawer(): void {
  isDrawerOpen.set(false);
  if (unregisterBack) {
    unregisterBack();
    unregisterBack = null;
  }
  // A drag that started from a drawer icon has nowhere to land once the drawer itself is
  // gone — leaving it live would strand the ghost icon on screen with no drop target.
  cancelIconDrag();
}

export function toggleDrawer(): void {
  if (get(isDrawerOpen)) {
    closeDrawer();
  } else {
    openDrawer();
  }
}
