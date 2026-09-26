// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { useNuiBridge } from '@mica/sdk/core';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';

/**
 * The wallpapers the server owner dropped in `branding/wallpapers/` (MICA-236), as
 * `shell:ownerConfig` lists them. Settings is a `core` app and may not import shell state,
 * so it asks for the same answer through the raw transport it is allowed.
 */
export const ownerWallpapers = writable<string[]>([]);

/**
 * A URL that goes into a `url('…')` must not be able to close it. The server sends
 * `https://cfx-nui-<resource>/branding/…` (or a `/path` in the browser mock); anything with a
 * quote, bracket, backslash or space is dropped rather than escaped.
 */
const SAFE_URL = /^(https:\/\/cfx-nui-[\w.-]+\/|\/)[^'"()\\\s]+$/;

export const safeWallpaperUrls = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((u): u is string => typeof u === 'string' && SAFE_URL.test(u))
    : [];

export async function loadOwnerWallpapers(): Promise<void> {
  const { fetchNui } = useNuiBridge();
  const reply = await fetchNui<{ wallpapers?: unknown }>(
    GENERIC_SERVICE_ACTION,
    { service: 'shell', action: 'ownerConfig' },
    { defaultValue: {} }
  );
  ownerWallpapers.set(safeWallpaperUrls(reply?.wallpapers));
}
