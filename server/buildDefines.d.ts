// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three build-time `define`s `sdk/version.ts` reads, declared for the server's compiler
 * (MICA-237).
 *
 * `services/Store.ts` imports `SDK_CONTRACT_VERSION` from there rather than keeping a copy,
 * and the file it lives in also reads these behind `typeof` guards. The server bundle
 * substitutes none of them, so at runtime each guard takes its fallback; this only tells
 * `tsc` the names exist. Matches `web/src/vite-env.d.ts` and `sdk/env.d.ts`.
 */
declare const __MICA_VERSION__: string;
declare const __MICA_BUILD_INFO__: string;
declare const __MICA_BRANCH__: string;
