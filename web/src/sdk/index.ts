/**
 * MICA-176. `sdk/index.ts` is the core-side entry of `@gphone/sdk` and `sdk/addon.ts` is
 * the add-on-side one, so this is where the core side picks its facet set — the mirror of
 * `addon.ts` pulling the iframe set in through `export { bootAddOn } from './host/iframe/boot'`.
 * Neither file is in the other's bundle: `vite.addon.config.ts` aliases `@gphone/sdk` to
 * `addon.ts`, `vite.config.ts` aliases it here.
 *
 * `src/main.ts` imports the same set first and directly, and still must: the shell reaches
 * plenty of `shell/state/*` without going through this barrel, and a module-scope
 * `usePersisted` there cannot wait for whenever an app happens to import `@gphone/sdk`.
 * A second import of an already-evaluated module is free.
 */
import './host/inProcess/registerFacets';
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
export { createCrudStore, byNewest } from '../services/createCrudStore';
export type { CrudEvents, CrudOptions } from '../services/createCrudStore';
export { createPagedStore } from '../services/createPagedStore';
export type { PagedStore } from '../services/createPagedStore';
/**
 * @public
 * The reader form of `createPagedStore`'s first argument — an app needs the type to name a
 * paged read that goes through a facet (`useAccounts().getFollowers`) rather than a route.
 */
export type { PageReader } from '../services/createPagedStore';
export {
  setTrustedRemoteAppHosts,
  getTrustedRemoteAppHosts
} from '../shell/state/remoteAppSecurity';
/**
 * @public
 * MICA-70's one privacy-disclosure string, read by both the first-run notice
 * (`shell/PrivacyNotice.svelte`) and the permanent copy in Settings > About — plain text
 * with nothing reactive about it, so there is no facet or permission to gate it behind
 * (the same reasoning `MICA_BUILD_INFO` above already rests on).
 */
export { PRIVACY_NOTICE_TEXT } from './privacyNotice';
/**
 * `svelte/transition`'s `fade` and `fly`, wrapped so they honour Settings > Display >
 * Motion (MICA-66). Exported here because an app may not import the shell by path
 * (§2.7), and because a Svelte 5 transition runs on the Web Animations API — a `duration:`
 * in an app's markup is invisible to CSS, `prefers-reduced-motion` included, so importing
 * the originals would quietly opt that app out of the setting. `motion.test.ts` fails if
 * anything does.
 */
export { fade, fly } from '../lib/sdk/motion';
export { fetchCatalog, getRemoteCatalogUrl, setRemoteCatalogUrl } from '../shell/state/catalog';
export type { CatalogEntry } from '../shell/state/catalog';
/**
 * The Store renders the update rows; `useAppRegistry()` is what produces them. Only the
 * type crosses the boundary here — the list itself comes from the permission-gated facet.
 */
export type { AppUpdate, AppUpdateKind } from '../shell/state/appUpdates';
export { AppPermissionError } from './host/protocol';
/** @public */
export type { Host } from './host/protocol';
export type { Facets } from './host/facets';
export type { TimeState } from '../shell/state/time';
export type { ResolvedKeybindAction } from '../shell/state/keybinds';
export type { RunningApp } from '../shell/state/navigation';
export type { ToastMessage } from '../shell/state/toast';
export type { AppEvent } from '../shell/state/appEvents';
export type { M3Tokens } from '../lib/sdk/m3';
export type { FollowPage, FollowListQuery, AccountSearchQuery } from '../services/accounts';
export type { ListingPage, CreateListingInput } from '../services/marketplace';
export type { SendMoneyOutcome, SendMoneyInput } from '../services/bank';
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
export {
  placeholderAvatar,
  placeholderPhoto,
  placeholderPhotos
} from '../lib/sdk/placeholderImage';
export * from './types';
export * from './version';
