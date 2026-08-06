import { writable, get } from 'svelte/store';
import { registerHandler } from './keybinds';

export const isShadeOpen = writable<boolean>(false);

let unregisterBack: (() => void) | null = null;

export function openShade(): void {
  if (get(isShadeOpen)) return;
  isShadeOpen.set(true);

  if (!unregisterBack) {
    unregisterBack = registerHandler('back', () => {
      closeShade();
    });
  }
}

export function closeShade(): void {
  isShadeOpen.set(false);
  if (unregisterBack) {
    unregisterBack();
    unregisterBack = null;
  }
}

export function toggleShade(): void {
  if (get(isShadeOpen)) {
    closeShade();
  } else {
    openShade();
  }
}
