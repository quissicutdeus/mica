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
export {
  setTrustedRemoteAppHosts,
  getTrustedRemoteAppHosts
} from '../shell/state/remoteAppSecurity';
export { fetchCatalog } from '../shell/state/catalog';
export type { CatalogEntry } from '../shell/state/catalog';
export { AppPermissionError } from './host/protocol';
/** @public */
export type { Host } from './host/protocol';
export * from './types';
export * from './version';
