// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MICA-172 removed an `import '../web/src/host/registerFacets';` that used to sit here.
 *
 * MICA-176 put it in, so anything reaching the SDK through its own entry specifier got a
 * facet set without saying so — the core-side mirror of `addon.ts` pulling the iframe set in
 * through `bootAddOn`. That worked while the in-process facets lived inside `sdk/`. They now
 * live in `web/src/host/`, on the phone's side of the boundary this ticket exists to draw,
 * and a package importing its consumer is the whole thing being fixed.
 *
 * So the shell's entry point is the only thing that installs the in-process set:
 * `src/main.ts`, first import. A unit test is its own entry point and says which side it is
 * standing in for.
 */
export * from './manifest';
export * from './components';
export * from './icons';
export * from './utils';
export * from './host/index';
export * from './kit/index';
/**
 * The list-store factory, so an add-on can have one.
 *
 * It lives in `services/` because core's own services use it, and it is exported here
 * because an app cannot import by path (§2.7) — without this line, building a list means
 * reimplementing the ordering, the `loaded` flag and the no-optimism rule that took
 * several rewrites to settle. Paired with `CrudOptions.service`, which is how an app
 * reaches its own server without a route table entry.
 */
export { createCrudStore, byNewest } from './createCrudStore';
export type { CrudEvents, CrudOptions } from './createCrudStore';
export { createPagedStore } from './createPagedStore';
export type { PagedStore } from './createPagedStore';
/**
 * @public
 * The reader form of `createPagedStore`'s first argument — an app needs the type to name a
 * paged read that goes through a facet (`useAccounts().getFollowers`) rather than a route.
 */
export type { PageReader } from './createPagedStore';
export { setTrustedRemoteAppHosts, getTrustedRemoteAppHosts } from './remoteAppSecurity';
/**
 * @public
 * MICA-70's one privacy-disclosure string, read by both the first-run notice
 * (`shell/PrivacyNotice.svelte`) and the permanent copy in Settings > About — plain text
 * with nothing reactive about it, so there is no facet or permission to gate it behind
 * (the same reasoning `MICA_BUILD_INFO` above already rests on).
 */
export {
  MICA_SOURCE_URL,
  LICENSE_COPYRIGHT,
  LICENSE_FREEDOMS,
  LICENSE_NAME,
  LICENSE_SPDX,
  LICENSE_SOURCE_OFFER,
  LICENSE_WARRANTY,
  sourceUrlForBuild
} from './licenseNotice';
export { PRIVACY_NOTICE_TEXT } from './privacyNotice';
/**
 * `svelte/transition`'s `fade` and `fly`, wrapped so they honour Settings > Display >
 * Motion (MICA-66). Exported here because an app may not import the shell by path
 * (§2.7), and because a Svelte 5 transition runs on the Web Animations API — a `duration:`
 * in an app's markup is invisible to CSS, `prefers-reduced-motion` included, so importing
 * the originals would quietly opt that app out of the setting. `motion.test.ts` fails if
 * anything does.
 */
export { fade, fly } from './lib/motion';
export { fetchCatalog, getRemoteCatalogUrl, setRemoteCatalogUrl } from './catalog';
export type { CatalogEntry } from './catalog';
/**
 * The Store renders the update rows; `useAppRegistry()` is what produces them. Only the
 * type crosses the boundary here — the list itself comes from the permission-gated facet.
 */
export type { AppUpdate, AppUpdateKind } from './vocabulary/shell';
export { AppPermissionError } from './host/protocol';
/** @public */
export type { Host } from './host/protocol';
export type { Facets } from './host/facets';
export type { TimeState } from './vocabulary/shell';
export type { ResolvedKeybindAction } from './vocabulary/shell';
export type { RunningApp } from './vocabulary/shell';
export type { ToastMessage } from './vocabulary/shell';
export type { AppEvent } from './vocabulary/shell';
export type { M3Tokens } from './lib/m3';
export type { FollowPage, FollowListQuery, AccountSearchQuery } from './vocabulary/accounts';
export type { ListingPage, CreateListingInput } from './vocabulary/marketplace';
export type { SendMoneyOutcome, SendMoneyInput } from './vocabulary/bank';
/**
 * Deterministic placeholder imagery, for the fixtures an app renders in a browser.
 *
 * Exported for the same reason `createCrudStore` above is: an app cannot import by path
 * (§2.7), and both app-side consumers of these are apps — the camera's stand-in
 * viewfinder frames and Developer Tools' test-SMS avatar. Without this line each would
 * have to carry its own copy of the generator, or go back to hotlinking someone else's
 * avatar service (MICA-35).
 *
 * Safe to sit in the SDK because `lib/` is state-free and I/O-free by definition
 * (AGENTS.md §8), so it bundles into a sandboxed add-on unchanged.
 */
export { placeholderAvatar, placeholderPhoto, placeholderPhotos } from './lib/placeholderImage';
export * from './types';
export * from './version';
