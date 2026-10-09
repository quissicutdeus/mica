// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a picture's source may be, and how one reaches CSS. MICA-339.
 *
 * Here rather than in any one target because every target asks: the server holds a client's
 * `mica_media.data` to `isInlineImage`, `MediaThumb` (`sdk/ui`) draws `data` only when it is an
 * inline image, and the wallpaper — set from Settings, from an add-on through the
 * `wallpaperWrite` facet, or read back from this PC's storage — reaches PhoneFrame's `style`
 * attribute only through `wallpaperImage`. One definition, so the three cannot drift.
 *
 * No DOM and no Node: `shared/` is compiled for the server too.
 */

/**
 * A raster image as a base64 data URI — what the camera encodes, and the shape
 * `server/lib/mediaHost.ts` posts to an image host. Anchored at both ends.
 */
const RASTER_DATA_URI = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * The camera's own stand-in when a capture comes back empty (`sampleAvatars[0]`): a generated
 * SVG, URL-encoded with `encodeURIComponent`. Only the characters that encoding leaves as they
 * are, less the `'` it also leaves. An SVG drawn as an image loads nothing and runs nothing.
 */
const SVG_DATA_URI = /^data:image\/svg\+xml,[A-Za-z0-9%!*~._()-]+$/;

/**
 * Whether `value` is an image carried inline: one of the two shapes above, and nothing that
 * points anywhere. What a client may store as a media row's `data`.
 */
export const isInlineImage = (value: unknown): value is string =>
  typeof value === 'string' && (RASTER_DATA_URI.test(value) || SVG_DATA_URI.test(value));

/**
 * Whether `value` is any `data:image/` URI. The weaker question `MediaThumb` asks of `data`:
 * a `data:` URI fetches nothing, so it cannot be a beacon whatever its exact shape, and a row
 * a server resource wrote through `AddMedia` is not held to the camera's two shapes.
 */
export const isDataImage = (value: unknown): value is string =>
  typeof value === 'string' && /^data:image\//i.test(value);

/**
 * `value` as a quoted CSS `url('…')`, with anything that could end the string written as a
 * CSS hex escape. A `'` left as it is closes the string, and every declaration after it
 * applies to whatever element the value is written on.
 */
export const cssUrl = (value: string): string =>
  `url('${value.replace(/[\\'"\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}')`;

/**
 * A remote or resource-relative wallpaper address: `https:`, or a path on this resource
 * (`/…`, which is what the browser mock's owner wallpapers are). No quote, paren, backslash,
 * angle bracket, backtick or whitespace — so `cssUrl` never has anything to escape in one, and
 * a value read back from storage comes out of `wallpaperImage` exactly as it went in.
 */
const ADDRESS = /^(?:https:\/\/[^/'"()\\\s<>`]+|\/(?!\/))[^'"()\\\s<>`]*$/;

/** `url(…)` around a source, quoted either way or not at all. */
const CSS_URL = /^url\(\s*(['"]?)(.*)\1\s*\)$/s;

/**
 * The CSS `background` image for `value`, or `null` when it is not one a wallpaper may be.
 *
 * `value` is a bare source or a `url(…)` around one — the facet's contract has always been the
 * latter, and Settings builds it. Its source must be an inline image or an `https:` (or
 * resource-relative) address with nothing in it that could close the string, and the answer is
 * rebuilt by `cssUrl` rather than passed through: what reaches the `style` attribute is never
 * the caller's string, only a source this function vetted, re-quoted.
 *
 * An `https:` address stays legal, as it always was for an add-on's own host — the player
 * installed the add-on. `http:`, any other scheme and anything carrying a `'` are refused.
 */
export const wallpaperImage = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const wrapped = CSS_URL.exec(trimmed);
  const source = wrapped ? wrapped[2].trim() : trimmed;
  if (source === '') return null;
  return isInlineImage(source) || ADDRESS.test(source) ? cssUrl(source) : null;
};
