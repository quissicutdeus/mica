// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Types for `license-banner.js`, which is plain JS so `build/build-bundle.js` can import it
 * too. Without this, the two Vite configs fail `tsc -p tsconfig.node.json` with `TS7016`
 * (the same trap `vite.addon.config.ts` documents about `scripts/addonIds.mjs`) — and the
 * alternative, a third copy of the copyright line, is one nobody would keep in step.
 */
import type { Plugin } from 'vite';

export declare const LICENSE_BANNER: string;
export declare function licenseBanner(): Plugin;
