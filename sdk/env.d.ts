// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable @typescript-eslint/triple-slash-reference --
   these load ambient globals (import.meta.env, etc.); an `import` doesn't have the same effect. */
/// <reference types="svelte" />
/// <reference types="vite/client" />
/* eslint-enable @typescript-eslint/triple-slash-reference */

/**
 * The SDK's own ambient environment. MICA-172.
 *
 * These lived in `web/src/vite-env.d.ts` while the SDK was a directory inside `web/src`, and
 * a package that cannot state its own environment is not a package — so this declares the
 * three things the SDK itself reaches for, and nothing else. `web/src/vite-env.d.ts` keeps
 * the phone's half (the dev-harness `window` hooks, `appRegistryStore`, `mockCalls`), which
 * the SDK does not touch.
 *
 * Both files declare `__GOS_VERSION__` and `__GOS_BUILD_INFO__`. That is duplication,
 * but not the kind that drifts dangerously: they are `define` substitutions supplied by
 * whichever Vite config is building, and `vite.addon.config.ts` already fails the build on
 * any that survives unsubstituted (`gos-no-unsubstituted-defines`). A mismatch is caught
 * there rather than shipped.
 */

declare module '*.svelte' {
  import type { ComponentType, SvelteComponent } from 'svelte';
  const component: ComponentType<SvelteComponent>;
  export default component;
}

declare const __GOS_VERSION__: string;
declare const __GOS_BUILD_INFO__: string;
declare const __GOS_BRANCH__: string;

interface Window {
  /**
   * Present only inside CEF. Its absence is what `lib/isBrowser.ts` checks, which is the
   * one nonstandard global the SDK itself reads.
   */
  invokeNative?: unknown;
}
