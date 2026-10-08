// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Helpers and query-string flags more than one file under `./services/` reads (MICA-323).
 *
 * Only what is genuinely shared lives here; a flag or a fixture one service uses stays in
 * that service's file. Fixtures shared across services are in `./data.ts` (static rows) or
 * `./social.ts` (the account and Blab state several services mutate).
 */

// Helper to simulate delays
export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The owner-config convars (MICA-234), as this transport's stand-in for `server.cfg`:
 * `window.location.search` first — read only, never navigated (§6 bans it in CEF, and a
 * browser tab has no reason to either) — then a `VITE_MICA_*` build-time env var, so both
 * an e2e spec (`?mica_disabled_apps=...`) and a `pnpm dev` session
 * (`VITE_MICA_DISABLED_APPS=... pnpm dev`) can walk the loop end to end without a server.
 * Unset, which is every ordinary `pnpm dev`, every Playwright run and every production
 * build, resolves to exactly what an unconfigured client answers.
 */
export const ownerConfigRaw = (query: string, envValue: string | undefined): string => {
  if (typeof window !== 'undefined') {
    const fromQuery = new URLSearchParams(window.location.search).get(query);
    if (fromQuery !== null) return fromQuery;
  }
  return String(envValue ?? '');
};

/**
 * `?state=fresh` presents the phone as never used before.
 *
 * Without it the first-run experience was **unreachable in the browser**: the fixtures always hold
 * data, so Blabber's claim gate — the screen that asks for your first handle, and the only thing a
 * new player sees — never rendered in `pnpm dev` or under Playwright. A path no developer can look
 * at is a path that rots, and this one is every player's first impression.
 *
 * **One axis, not a list of app ids.** This began as `?fresh=blabber`, which made the ordinary
 * invocation repeat the id it had just handed `?app=` — `?app=blabber&fresh=blabber` — to buy
 * per-app independence nothing asked for. Whether the data is fresh is orthogonal to which app you
 * open, so it reads as `?app=blabber&state=fresh`. An app that later grows its own notion of prior
 * use reads the same flag and needs no entry anywhere.
 *
 * **Not the default for `?app=`, deliberately.** Opening an app to look at a populated feed is the
 * ordinary case — every other spec in `e2e/apps/` needs one — so a deep link that always started
 * empty would take away the thing the harness is mostly for.
 *
 * Dev-only in the sense that nothing in the game supplies a query string.
 */
export const startFresh =
  (typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('state')) === 'fresh';

/**
 * `?bluetoothNearby=N` simulates N other Bluetooth-visible players in range.
 *
 * There is no "who is nearby" concept to mock against — there are no other players in the
 * browser at all — so this is the axis that makes both outcomes (delivered to someone /
 * nobody in range) reachable in `pnpm dev` and in Playwright. Defaults to 0 rather than a
 * plausible-looking number, same reasoning `startFresh` documents above: a mock that
 * always succeeds hides the empty-range path from anything that doesn't think to ask for
 * the other one.
 */
export const bluetoothNearbyCount =
  (typeof window === 'undefined'
    ? null
    : Number(new URLSearchParams(window.location.search).get('bluetoothNearby'))) || 0;
