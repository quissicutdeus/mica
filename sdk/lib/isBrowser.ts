// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where this code is running: a plain browser tab, FiveM's CEF, or nowhere with a DOM.
 *
 * Three answers, not two, and `headless` is the one that earns this its own function
 * (MICA-177). `isBrowser()` below used to be `!window.invokeNative` with no guard, so
 * where there is no `window` at all it threw `ReferenceError` instead of answering. Both
 * cheap guards are wrong, and that is why the third state exists rather than a default:
 *
 * - Answer `true` with no `window`, and every module-scope `if (isBrowser())` that then
 *   writes a dev helper onto `window` (`shell/state/charge.ts`) throws one line later.
 * - Answer `false` with no `window` and say nothing, and every `!isBrowser()` branch takes
 *   the CEF path under a node test, silently. A test that meant to exercise the browser
 *   path exercises the CEF path instead and stays green, which is worse than the crash.
 *
 * So the predicate keeps its published boolean and its published answer for the two real
 * runtimes, and a caller that needs to know the third can ask for it by name. The same
 * shape as `detectFramework`'s `unknown` in `server/lib/FrameworkBridge.ts`: a state
 * nothing can act on safely without knowing is a first-class answer, never folded into
 * whichever default happens to be nearest.
 *
 * What `headless` actually is: a Vitest file in the node environment, or any module graph
 * loaded outside a page. Never a phone. CEF and a browser tab both have a `window`.
 */
export type HostRuntime = 'browser' | 'cef' | 'headless';

export const hostRuntime = (): HostRuntime => {
  if (typeof window === 'undefined') return 'headless';
  return window.invokeNative ? 'cef' : 'browser';
};

/**
 * Whether this is a plain browser tab, as opposed to FiveM's CEF.
 *
 * `false` for `headless`, and that is an answer rather than a fallback: no `window` is
 * definitively not a browser tab. Every consumer whose CEF branch could do harm without
 * a DOM was read for this (MICA-177) and either guards `typeof window` itself
 * (`shell/state/audio.ts`), returns early on the CEF side, is component markup that
 * cannot render headless anyway, or — the one that mattered — asks `hostRuntime()` and
 * refuses out loud: `web/src/nui/transport.ts` will not pick a transport for a headless
 * runtime, because a node test that reaches the transport without `setTransport()` is a
 * test-configuration mistake and should read as one.
 */
export const isBrowser = (): boolean => hostRuntime() === 'browser';
