// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isInlineImage } from '@mica/shared/imageSource';

/**
 * What a client payload may write into `mica_media`'s two client-writable columns. MICA-339.
 *
 * Both are `accepts` rules on the declaration in `services/Media.ts`, so they hold on the
 * generic `create` — the one path a payload reaches — and on nothing else: `addForPlayer`,
 * `copyToPlayers` and `storeThumbnail` are named server paths that never pass through
 * `ServiceEndpoint`'s column rules, which is what lets `shareLocation` and `AddMedia` keep
 * writing what a client may not.
 */

/**
 * The one kind a client creates: a photo. The camera is the only client writer, and it says
 * `photo` (`web/src/host/facets/media.ts`).
 *
 * The enum is wider on purpose (`Media.ts` says why), but every other kind is written by a
 * server path or by nobody yet. A `location` row is the reason this is an allowlist rather than
 * a refusal of one value: its coordinates are only ever `playerCoords(source)` in
 * `shareLocation`, and a recipient's "Add waypoint" acts on them, so a client-written one is a
 * forged position wearing a server-verified card. A kind a future client feature needs is added
 * here in the same change as the feature.
 */
export const acceptsClientKind = (value: string): boolean => value === 'photo';

/**
 * Whether a client may store `value` as a row's `data`: an inline image and nothing else —
 * a raster base64 data URI, or the camera's URL-encoded SVG stand-in for an empty capture
 * (`shared/imageSource.ts`, which `MediaThumb` and the wallpaper read too).
 *
 * **No URL of any kind, the configured image host's included.** A remote URL here was the
 * beacon: every viewer of a shared row, a Blab or a listing fetched it from their own machine,
 * handing its owner their IP. `url` is the column a hosted or hotlinked image lives in, and it is
 * `clientWritable: false` — the image host's URLs reach it only from `uploadImage`, through
 * `validateHostedUrl`. A host URL written into `data` would also be invisible to the reference
 * check `releaseHostedImages` makes on `url`, so a prune could delete the file under a row
 * still showing it. No client writer produces one: the camera only ever has bytes.
 */
export const acceptsClientData = (value: string): boolean => isInlineImage(value);
