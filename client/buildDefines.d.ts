// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The build defines `sdk/version.ts` reads, declared for the client compile (MICA-237).
 *
 * `RemoteApps.ts` imports `SDK_CONTRACT_VERSION` from there to key the public add-on
 * catalog, which pulls the whole file into this target. The web build substitutes these
 * with `define` and declares them in `web/src/vite-env.d.ts`; the client bundle substitutes
 * none, so at runtime each is undeclared and `version.ts`'s `typeof` guard answers `''`.
 * The types match the web declarations so the two targets read the file the same way.
 */
declare const __MICA_VERSION__: string;
declare const __MICA_BUILD_INFO__: string;
declare const __MICA_BRANCH__: string;
