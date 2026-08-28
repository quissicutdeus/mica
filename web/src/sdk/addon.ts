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
export { createPagedStore } from '../services/createPagedStore';
/**
 * @public
 * The reader form of `createPagedStore`'s first argument — an app needs the type to name a
 * paged read that goes through a facet (`useAccounts().getFollowers`) rather than a route.
 */
export type { PageReader } from '../services/createPagedStore';
export { AppPermissionError } from './host/protocol';
/** @public */
export type { Host } from './host/protocol';
export * from './types';
export * from './version';
/** @public */
/**
 * The motion-aware `fade`/`fly`, mirroring `index.ts` (MICA-66).
 *
 * An add-on builds against this file rather than `index.ts`, in its own bundle, so an
 * export added only there is missing here — and nothing catches it until `pnpm build`,
 * because typecheck and the unit suite both resolve the core surface. Notes reaching for
 * `fade` is what found it.
 *
 * It matters more for an add-on than for a core app, not less: a `core: false` bundle
 * cannot import `shell/` by any route, so this is the only way it can honour Settings >
 * Display > Motion at all.
 */
export { fade, fly } from '../lib/motion';

export { bootAddOn } from './host/iframe/boot';
