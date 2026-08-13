import { writable, get } from 'svelte/store';
import { registerHandler } from './keybinds';

export const isShadeOpen = writable<boolean>(false);

/**
 * 0 (closed) .. 1 (open). Only meaningful while `shadeDragPhase` is not `'idle'` — a
 * drag gesture (status-bar pull-open, grab-handle pull-closed) writes it continuously,
 * and the drawer reads it to render mid-gesture, before `isShadeOpen` itself flips.
 */
export const shadeDragProgress = writable<number>(0);

/**
 * `'dragging'`: raw pointer tracking, no easing — the drawer must track the finger 1:1.
 * `'settling'`: the CSS-eased snap to the commit/springback target, after release.
 * `'idle'`: no gesture in flight; `isShadeOpen` alone drives rendering, as before this
 * feature existed.
 *
 * Deliberately separate from `isShadeOpen` rather than folded into it: the drawer must be
 * able to render mid-drag before the shade is officially open (and the `back` keybind
 * that `openShade` registers must not fire until the drag actually commits), and the
 * transform's easing must be present only during `'settling'`, absent during a live drag.
 * A single boolean cannot express either distinction.
 */
export type ShadeDragPhase = 'idle' | 'dragging' | 'settling';
export const shadeDragPhase = writable<ShadeDragPhase>('idle');

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
