// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
export { AppPermissionError } from './host/protocol';
/** @public */
export type { Host } from './host/protocol';
/**
 * MICA-129: type-only re-exports whose **values** already cross into an add-on bundle
 * through the barrels above — `createCrudStore`, `usePagedList`, `useKeybinds` and the rest
 * are callable from here, and until this line an add-on could call them and never name what
 * they return. Each one is erased at build time (`seam.test.ts`'s `VALUE_IMPORT`/
 * `VALUE_EXPORT` both exempt `export type`), so adding it here costs nothing at runtime even
 * where the module behind it is otherwise shell/in-process-only (`Facets`, `TimeState`,
 * `ResolvedKeybindAction`, `ToastMessage`, `AppEvent`, `RunningApp`) — nothing is actually
 * imported, only the shape.
 */
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
export type { AppUpdate, AppUpdateKind } from './vocabulary/shell';
/**
 * Deterministic placeholder imagery, for the fixtures an add-on renders in a browser.
 *
 * Mirrors `index.ts`'s own re-export (MICA-129 closed the gap): `lib/` is state-free and
 * I/O-free by definition (AGENTS.md §8), so this bundles into a sandboxed add-on unchanged.
 */
export { placeholderAvatar, placeholderPhoto, placeholderPhotos } from './lib/placeholderImage';
export * from './types';
export * from './version';
/**
 * @public
 * MICA-70's privacy-disclosure string — plain, state-free text, so it bundles into a
 * sandboxed add-on unchanged. Mirrors `index.ts`'s own re-export.
 */
export { PRIVACY_NOTICE_TEXT } from './privacyNotice';
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
export { fade, fly } from './lib/motion';

export { bootAddOn } from './host/iframe/boot';
