// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, type Readable, type Writable } from 'svelte/store';
import type { ToastMessage, Translate } from '@mica/sdk';

/**
 * Ten taps on the OS Version row reveals Developer Tools, the way Android reveals its
 * developer options.
 *
 * Extracted from the phone root (MICA-261) because the tablet root shows the same About
 * pane and has to unlock the same row. Two copies of a counter, a 2 s reset timer and four
 * toasts would drift the moment either root was touched -- and the drift would be silent,
 * because nothing renders the count.
 *
 * Every dependency is passed in rather than reached for: this is a plain module, so the
 * hooks it would otherwise call (`useLocale`, `usePhoneNotification`, `useDevTools`,
 * `useAdmin`, `useTimer`) have no component to resolve against. Each root already holds
 * them and hands them over.
 *
 * The flag lives in a module-scope store rather than here, and is not persisted -- see
 * `store/devtools.ts`. It resets when the phone closes, so the row is absent on every
 * fresh open until the taps are done again.
 */
export interface DevToolsUnlockDeps {
  /** `useLocale().t` -- the store, not a snapshot: the language can change under us. */
  t: Readable<Translate>;
  toast: { show: (options: Partial<ToastMessage> & { message: string }) => string };
  devToolsUnlocked: Writable<boolean>;
  isAdmin: Readable<boolean>;
  /** `useTimer().after` -- duration first, and cancellable, so it cannot outlive the app. */
  after: (ms: number, handler: () => void) => () => void;
}

export interface DevToolsUnlock {
  /** One tap on the OS Version row. */
  tap: () => void;
  /**
   * Put the row away again. The caller moves off the Developer Tools pane itself -- which
   * pane it moves *to* is the root's business, and the two roots differ.
   */
  hide: () => void;
}

export const TAPS_TO_UNLOCK = 10;

/** How long a gap may be between taps before the count starts over. */
const TAP_RESET_MS = 2000;

export function createDevToolsUnlock(deps: DevToolsUnlockDeps): DevToolsUnlock {
  const { t, toast, devToolsUnlocked, isAdmin, after } = deps;

  // A plain closure rather than `$state`: nothing renders the count, so reactivity would
  // buy nothing, and a module like this one has no component to be reactive inside.
  let taps = 0;
  let cancelTapReset: (() => void) | undefined;

  const tap = () => {
    if (get(devToolsUnlocked)) return;

    const translate = get(t);

    if (!get(isAdmin)) {
      // Say so outright. Silently counting to ten and then showing nothing reads as a
      // broken build.
      toast.show({
        type: 'error',
        app: 'settings',
        message: translate('settings.devtools.adminRequired')
      });
      return;
    }

    taps += 1;
    cancelTapReset?.();
    // Taps must be consecutive; drifting off resets the count.
    cancelTapReset = after(TAP_RESET_MS, () => (taps = 0));

    const remaining = TAPS_TO_UNLOCK - taps;
    const title = translate('settings.devtools.title');

    if (remaining <= 0) {
      devToolsUnlocked.set(true);
      taps = 0;
      cancelTapReset?.();
      toast.show({
        type: 'success',
        app: 'settings',
        title,
        message: translate('settings.devtools.unlockedToast')
      });
    } else if (remaining <= 3) {
      toast.show({
        type: 'info',
        app: 'settings',
        title,
        message: translate('settings.devtools.moreToUnlock', { remaining })
      });
    }
  };

  const hide = () => {
    devToolsUnlocked.set(false);
    taps = 0;
    cancelTapReset?.();
    toast.show({
      type: 'info',
      app: 'settings',
      message: get(t)('settings.devtools.hiddenToast')
    });
  };

  return { tap, hide };
}
