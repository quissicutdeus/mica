// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keep Tab inside a modal surface, and put focus back where it came from on close.
 *
 * A Svelte action, alongside `pointerDrag` and `longPressDrag`: DOM behaviour with no
 * gOS state behind it, usable from `shell/` and from `sdk/ui/` without either
 * importing the other.
 *
 * ## Why an element with `role="dialog"` needs this
 *
 * `role="dialog"` is a claim, and until MICA-66 the phone was making it falsely.
 * `AppDrawer` and `NotificationShade` both announced themselves as dialogs and then let
 * Tab walk straight out into the app behind them — which is still fully rendered, still
 * in the tab order, and visually behind a scrim the keyboard knows nothing about. A
 * screen-reader user was told "dialog" and then handed the contents of another screen.
 *
 * ## What it does, and what it deliberately does not
 *
 * It handles the **Tab key**: forward off the last tabbable wraps to the first, backward
 * off the first wraps to the last, and a Tab pressed while focus is somewhere outside
 * entirely (nothing focused, or focus left by a click) is redirected inside. That is the
 * whole mechanism, and it is enough — every route out of a dialog by keyboard goes
 * through Tab.
 *
 * It does **not** pull focus back on `focusin`. A pointer-driven phone gets focus events
 * from taps constantly, and a trap that fights them would fight the shell's own focus
 * management — `Shell.svelte` blurs focus out of a backgrounded app, `AppDrawer` focuses
 * its search box on open, `ToastHost` pauses a toast's dismissal on focus. A tap outside
 * one of these surfaces closes it anyway, which is the behaviour a mouse user expects.
 *
 * It does not move focus on mount either. The surfaces that should take focus already do
 * it themselves and know which control deserves it; a trap guessing "the first tabbable"
 * would have stolen the drawer's search field.
 *
 * ## Nesting
 *
 * Only the most recently mounted trap acts. A `ConfirmDialog` opened from inside the
 * notification shade must own Tab while it is up, and the shade must get it back when the
 * dialog closes — a stack is the smallest thing that gets both right, and without one the
 * two would both handle the same keystroke and fight over where it lands.
 */

/**
 * Everything that can hold focus by default, minus the ways an element opts out.
 *
 * `[tabindex]:not([tabindex="-1"])` rather than a bare `[tabindex]`: a programmatically
 * focusable container (the pattern `Screen` and the sheets use) is a focus *target*, not
 * a tab stop, and wrapping onto one would strand the player on an element that Tab then
 * immediately leaves again.
 */
const TABBABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Filtered on attributes only, never on layout.
 *
 * `offsetParent`, `getBoundingClientRect` and `getComputedStyle` are the usual way to ask
 * whether an element is visible, and all three are unreliable here: jsdom computes no
 * layout, so a test would see every candidate as hidden. Attributes cover the cases this
 * phone actually produces — `inert` on a backgrounded app, `disabled` on a spent button,
 * `hidden`, and `aria-hidden` on decoration.
 */
const isVisibleToKeyboard = (el: HTMLElement): boolean =>
  !el.hasAttribute('disabled') &&
  !el.hasAttribute('hidden') &&
  el.getAttribute('aria-hidden') !== 'true' &&
  !el.closest('[inert]') &&
  !el.closest('[aria-hidden="true"]');

const tabbablesIn = (node: HTMLElement): HTMLElement[] =>
  Array.from(node.querySelectorAll<HTMLElement>(TABBABLE)).filter(isVisibleToKeyboard);

/** Innermost trap wins; see the nesting note above. */
const stack: HTMLElement[] = [];

export interface FocusTrapOptions {
  /**
   * Off by default for a surface that is conditionally modal. Passing `false` leaves the
   * node in the stack's place but makes it transparent to the key handler, so a caller
   * does not have to tear the action down and rebuild it to suspend the trap.
   */
  enabled?: boolean;
  /**
   * Where focus goes when the trap is torn down. Defaults to whatever was focused when it
   * was set up, which is what "focus returns to whatever opened it" means in practice —
   * the launcher icon, the status bar, the row that opened the dialog.
   */
  returnFocusTo?: () => HTMLElement | null;
}

export function focusTrap(node: HTMLElement, options: FocusTrapOptions | boolean = true) {
  let opts: FocusTrapOptions = typeof options === 'boolean' ? { enabled: options } : options;

  const openedFrom = document.activeElement as HTMLElement | null;

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    if (opts.enabled === false) return;
    if (stack[stack.length - 1] !== node) return;

    const tabbables = tabbablesIn(node);
    if (tabbables.length === 0) {
      // A dialog with nothing to focus still must not leak Tab into the screen behind it.
      event.preventDefault();
      return;
    }

    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (!active || !node.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
      return;
    }

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    }
  };

  stack.push(node);
  // Capture, so the trap sees Tab before an app's own key handling does. The shell's
  // keybind dispatcher (`shell/state/keybinds.ts`) does not claim Tab, but an app is free
  // to, and a dialog's boundary is not an app's to override while it is open.
  document.addEventListener('keydown', onKeydown, true);

  return {
    update(next: FocusTrapOptions | boolean) {
      opts = typeof next === 'boolean' ? { enabled: next } : next;
    },
    destroy() {
      document.removeEventListener('keydown', onKeydown, true);
      const index = stack.lastIndexOf(node);
      if (index !== -1) stack.splice(index, 1);

      // Only if the dialog still holds focus. If something else has taken it in the
      // meantime — the player tapped a field on the screen behind, or the shell moved it
      // — putting it back would be the trap stealing focus on its way out.
      const active = document.activeElement as HTMLElement | null;
      if (active && !node.contains(active) && active !== document.body) return;

      const target = opts.returnFocusTo?.() ?? openedFrom;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  };
}
