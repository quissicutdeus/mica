// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppPermission } from '../../manifest';

// MICA-16 step 4: the postMessage wire format between the shell and a sandboxed add-on iframe.

export type FactoryArgs = readonly unknown[];

/** A function argument crossing the wall: replaced by a callback id the other side can fire. */
export interface CallbackRef {
  __cb: number;
}
/** A function *result* crossing the wall (an unsubscribe/release): a handle the client can `invoke`. */
export interface FnRef {
  __fn: number;
}

export type ToShell =
  | { kind: 'hello'; appId: string }
  | {
      kind: 'call';
      id: number;
      facet: string;
      factoryArgs: FactoryArgs;
      member: string;
      args: unknown[];
    }
  | { kind: 'subscribe'; id: number; facet: string; factoryArgs: FactoryArgs; member: string }
  | { kind: 'unsubscribe'; id: number }
  | { kind: 'invoke'; handle: number; args: unknown[] }
  | { kind: 'error'; message: string; stack: string | null }
  | {
      kind: 'key';
      key: string;
      code: string;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      metaKey: boolean;
      typing: boolean;
    }
  | { kind: 'typing'; typing: boolean };

export interface HydratePayload {
  appId: string;
  permissions: readonly AppPermission[];
  props: Record<string, unknown>;
  /** The `--color-*:` declaration block PhoneFrame applies — see shell/state/theme.ts themeStyleStore. */
  theme: string;
  /**
   * Every full `gos:<appId>:<key>` key → raw string (not stripped of its prefix — the
   * iframe `storage.ts` twin re-adds it before every cache read), so storage reads are
   * sync from boot.
   */
  storage: Record<string, string>;
  constants: AddOnConstants;
}

export interface AddOnConstants {
  display: Record<string, number>;
  wallpaper: { presets: unknown; defaultWallpaper: unknown };
  systemHardware: { volumeStepChoices: unknown };
  theme: { defaultTheme: unknown };
  /**
   * The 12-versus-24-hour preference, as a plain value.
   *
   * Unlike everything else here this one *can* change mid-session (Settings toggles it),
   * and it is a constant anyway: `formatTime`'s default reads it synchronously during the
   * frame's first paint, which no subscribe reply can be in time for. See
   * `iframe/shims/time.ts`.
   */
  clock: { is24Hour: boolean };
}

export type ToFrame =
  | { kind: 'hydrate'; payload: HydratePayload }
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | {
      kind: 'reply';
      id: number;
      ok: false;
      error: { name: string; message: string; permission?: string; hookName?: string };
    }
  | { kind: 'push'; id: number; value: unknown }
  | { kind: 'callback'; cb: number; args: unknown[] }
  | { kind: 'theme'; css: string }
  | { kind: 'storage'; snapshot: Record<string, string> }
  | { kind: 'props'; props: Record<string, unknown> };

export const isCallbackRef = (v: unknown): v is CallbackRef =>
  !!v && typeof v === 'object' && typeof (v as CallbackRef).__cb === 'number';
export const isFnRef = (v: unknown): v is FnRef =>
  !!v && typeof v === 'object' && typeof (v as FnRef).__fn === 'number';
