// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `release-zip.js`, a plain JS build module, covering what the tests import. */

export declare const BRIDGES_DIR: string;
export declare const LOCALES_DIR: string;
export declare const README_START: string;
export declare const README_END: string;
export declare const BRANDING_FILES: string[];
export declare const unexpectedBranding: (paths: string[]) => string[];
export declare function calVerOf(tag: string | null | undefined): string;
export declare function zipName(tag: string): string;
export declare function releaseDate(tag: string): Date;
export declare function stampManifestVersion(manifest: string, version: string): string;
export declare function readmeExcerpt(
  readme: string,
  options: { tag: string; repository: string }
): string;
export declare function manifestGlobs(manifest: string): string[];
export declare function globToRegExp(glob: string): RegExp;
export declare function uncoveredGlobs(manifest: string, paths: string[]): string[];
