// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable @typescript-eslint/triple-slash-reference --
   these load ambient globals (import.meta.env, etc.); an `import` doesn't have the same effect. */
/// <reference types="svelte" />
/// <reference types="vite/client" />
/* eslint-enable @typescript-eslint/triple-slash-reference */

declare module '*.svelte' {
  import type { ComponentType, SvelteComponent } from 'svelte';
  const component: ComponentType<SvelteComponent>;
  export default component;
}

declare const __GOS_VERSION__: string;
declare const __GOS_BUILD_INFO__: string;
declare const __GOS_BRANCH__: string;

/**
 * What CEF and the dev harness put on `window`.
 *
 * Declared rather than reached through `(window as any)` in eight places. Two of these
 * are CEF's — `invokeNative` is how `isBrowser()` tells a real phone from a browser tab,
 * and `GetParentResourceName` is how the NUI transport addresses the resource. The
 * `setX` ones are the dev harness, deliberately global so they can be called from the
 * browser console.
 */
interface Window {
  /** Dev harness: fire a server push without a server. See `devHarness.ts`. */
  pushAppEvent?: (
    app: string,
    event: string,
    payload?: Record<string, unknown>,
    notify?: unknown
  ) => void;
  /**
   * Dev harness: put somebody else's music next to you, without a server or a game.
   * See `devHarness.ts`. `volume` is invented here, because a browser has no distance.
   */
  pushNearbyMusic?: (
    rows?: {
      /** Server id, and the key the volume map goes out under. Defaults to 900 + index. */
      source?: number;
      /** The mute key, stable per person. Defaults to `dev<index>`. */
      token?: string;
      label?: string | null;
      videoId?: string | null;
      playlistId?: string | null;
      startedAt?: number;
      paused?: boolean;
      /** 0..1, invented — a browser has no distance. Defaults to full. */
      volume?: number;
    }[]
  ) => void;
  /** Present only inside CEF. Its absence is what `isBrowser()` checks. */
  invokeNative?: unknown;
  GetParentResourceName?: () => string;
  webkitAudioContext?: typeof AudioContext;

  // Dev harness, browser only.
  setBattery?: (value: number) => void;
  setDrainSpeed?: (multiplier: number) => void;
  setSignalLevel?: (level: number) => void;
  triggerTestToast?: (type?: 'message' | 'contact' | 'call' | 'email') => void;
  /**
   * The app registry, so an e2e test can install an app the repo does not ship —
   * a deliberately crashing one, for the error boundary.
   *
   * `error_boundary.spec.ts` already read this and it was never assigned, so every
   * assertion in that file sat behind an `if (count > 0)` that was never true and both
   * tests passed having checked nothing.
   */
  appRegistryStore?: typeof import('./shell/state/registry').appRegistryStore;
  /**
   * `fetchNui` by name, so a spec can call an action nothing mocks and prove the e2e
   * fixture fails on it. `nui.spec.ts` is the only reader.
   */
  fetchNui?: typeof import('./nui/fetchNui').fetchNui;
  /**
   * Every call the browser mock has answered this session, in order — see `MockCall` in
   * `nui/transport.ts`.
   *
   * The mock transport is in-process, so a NUI call makes no request for Playwright to
   * intercept. This is the only way an e2e spec can assert on the bridge itself: how many
   * times a list was fetched, or whether a list reply carried a column it should not.
   */
  mockCalls?: import('./nui/transport').MockCall[];
}
