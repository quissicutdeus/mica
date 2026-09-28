// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MediaItem } from './types';

/**
 * Whether a media row is a photo that lives on the external image host (MICA-243), and so
 * has a `url` and no `data`. The one place that decides it (MICA-293).
 *
 * Read off `url`, never off `data === ''`: the list read carries no `data` for any row
 * (MICA-110), so an empty `data` says nothing about where the photo is. A photo's `url`
 * is only ever set by the image host; a GIF's or video's `url` is not a photo's, hence the
 * `kind` check.
 */
export const isHostedPhoto = (item: Pick<MediaItem, 'kind' | 'url'>): boolean =>
  item.kind === 'photo' && typeof item.url === 'string' && item.url !== '';

/**
 * Whether a photo can be made into a wallpaper. A wallpaper is a `data:` URL, because the
 * theme seed is read from its pixels on a canvas and a cross-origin image would taint it.
 * A hosted photo has no bytes to hand over, so it is never a candidate.
 */
export const canBeWallpaper = (item: Pick<MediaItem, 'kind' | 'url' | 'thumbnail'>): boolean =>
  item.kind === 'photo' && !!item.thumbnail && !isHostedPhoto(item);

/**
 * A URL's host as the browser compares it: lower case, `:443` and a trailing dot dropped;
 * `null` for a relative URL (this resource, not a host) or a scheme that has none.
 * Parsed by hand rather than with `URL`, because `shared/` is compiled for the server too,
 * whose tsconfig has neither DOM nor Node types.
 */
const hostOf = (href: string): string | null => {
  const match = /^(?:https?:)?\/\/([^/?#\\]+)/i.exec(href.trim());
  if (!match) return null;
  const authority = match[1].toLowerCase().replace(/^[^@]*@/, '');
  const [, name = '', port = ''] = /^([^:]*)(?::(\d*))?$/.exec(authority) ?? [];
  const host = name.replace(/\.$/, '');
  return port === '' || port === '443' ? host : `${host}:${port}`;
};

/**
 * Whether a CSS `url('…')` wallpaper value points at nothing usable: an empty source (what
 * a hosted photo's blank `data` becomes) or a photo on the image host.
 *
 * A courtesy to the player, not a boundary: the worst an add-on that slips past it does is
 * set its own player a blank wallpaper. So it refuses only what it can name, and a value it
 * does not recognise passes, exactly as every value did before MICA-293 -- an add-on's
 * remote `https:` wallpaper on a host of its own stays legal. The host is compared parsed,
 * so `//host/…`, an explicit `:443` and a trailing dot are the same host.
 */
export const isUnusableWallpaperImage = (image: string, hostOrigin: string | null): boolean => {
  const match = /^url\(\s*(['"]?)(.*)\1\s*\)$/s.exec(image.trim());
  if (!match) return false;
  const source = match[2].trim();
  if (source === '') return true;
  if (hostOrigin === null) return false;
  const host = hostOf(source);
  return host !== null && host === hostOf(hostOrigin);
};
