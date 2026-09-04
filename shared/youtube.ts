// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a pasted YouTube link is reduced to before anything else touches it.
 *
 * MICA-111. Phase 1 has no server, so nothing here crosses the wire yet — it lives in
 * `shared/` anyway, for the same reason `shared/richText.ts` and `shared/deepLink.ts` do:
 * phase 2 has the server extract the id from a `mica:server:music:*` payload, and two
 * implementations of "what counts as a YouTube id" is how you get a string the phone
 * accepts and the server stores wrong. One parser, both sides.
 *
 * ## The rule: store the id, never the URL
 *
 * A player-supplied URL is attacker-controlled text (AGENTS.md §2.9). Held in a store it
 * would eventually be interpolated into an `<iframe src>` — and `src` is a navigation, so
 * a hostile string there is not defacement but a redirect out of the CEF instance, which
 * drops the whole phone (§6). Reducing to an id at the point of entry means the only thing
 * ever interpolated is a bounded token from a 64-character alphabet, and the origin is a
 * constant this repo writes.
 *
 * So this returns ids or `null`. There is deliberately no "pass the URL through" branch.
 *
 * ## What counts as an id
 *
 * A video id is exactly 11 characters of `[A-Za-z0-9_-]`; YouTube has never issued
 * another shape. A playlist id is the same alphabet but a range of lengths — `PL` + 32,
 * `UU`/`LL`/`FL` + 22, the `RD…` mixes YouTube generates itself — so it is bounded by
 * length rather than pinned to one, and by prefix only loosely. The charset is the part
 * that matters: no `/`, `?`, `&`, `#`, `"`, `<`, or whitespace can survive it, which is
 * what makes interpolation safe rather than merely tidy.
 */

/**
 * A YouTube link, matched whole.
 *
 * **`new URL` is not available here.** `shared/` is compiled by `client/tsconfig.json` and
 * `server/tsconfig.json`, both `lib: ["es2021"]` with no DOM and no Node types, so `URL`
 * is not a name either of them has. Parse-then-compare-the-host is therefore off the table
 * and this matches the *whole* string against the hosts instead — which is the stronger
 * shape anyway, because there is no extracted host to disagree about:
 *
 * - `(?:https?:\/\/)?` — an optional scheme, and only these two. `javascript:` and `data:`
 *   cannot match at all, since the pattern is anchored at `^`.
 * - `(?:(?:www|m|music)\.)?` — the only subdomains, so `notyoutube.com` cannot match by
 *   being a suffix of nothing and `evil.youtube.com` cannot match at all.
 * - `(?![^/?#])` after the host — whatever follows must be `/`, `?`, `#`, or the end of the
 *   string. That is what refuses `youtube.com.evil.test` (next char `.`),
 *   `youtube.com@evil.test` (`@`) and `youtube.com:8080@…` (`:`). A real URL parser would
 *   read the last two as *evil.test*; this refuses them, which is the safer disagreement.
 *
 * Capture 1 is the path, capture 2 the query. A fragment is matched and discarded.
 */
const YOUTUBE_URL =
  /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)(?![^/?#])([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i;

/** Is the link one of `youtu.be`'s, where the whole path is the video id? */
const SHORT_HOST = /^(?:https?:\/\/)?(?:www\.)?youtu\.be(?![^/?#])/i;

/** Path prefixes that carry the video id as the next segment: `/embed/ID`, `/shorts/ID`. */
const ID_IN_PATH = new Set(['embed', 'shorts', 'live', 'v']);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Playlist ids are 13–64 of the same alphabet.
 *
 * The floor is 13 rather than 2 so a bare 11-character *video* id can never be read as a
 * playlist, and so a stray word ("music") cannot become one. The ceiling is a bound, not
 * an observed maximum — the longest YouTube issues today is 34.
 */
const PLAYLIST_ID = /^[A-Za-z0-9_-]{13,64}$/;

export interface YouTubeSource {
  /** The video to play, when there is one. A playlist link alone has none. */
  videoId: string | null;
  /** The playlist to play through, when the link named one. */
  playlistId: string | null;
}

/**
 * Is there a YouTube id in there at all?
 *
 * A pure predicate rather than a return value from `playSource`, so a UI can validate a
 * paste *before* asking the phone to play it. That matters across the add-on seam: a
 * sandboxed app's `playSource` goes over `postMessage` and can only ever answer with a
 * promise, so a synchronous "is this a link" has to be something the app computes locally.
 * This file is pure and has no I/O, so it bundles into the sandbox unchanged.
 */
export const isYouTubeSource = (input: string): boolean => parseYouTubeSource(input) !== null;

export const isVideoId = (value: string): boolean => VIDEO_ID.test(value);
export const isPlaylistId = (value: string): boolean => PLAYLIST_ID.test(value);

/**
 * The still frame for a video, or `null` when there is no id to build one from.
 *
 * A plain image on YouTube's own thumbnail host — no script, no API key, and no request
 * the phone makes that the embed beside it was not already making. It lives here rather
 * than beside the player for two reasons: it is another string built by interpolating a
 * player-supplied value into a URL the browser will fetch, so it belongs next to the
 * validation that makes that safe; and it is pure, so it crosses the add-on seam into a
 * sandboxed bundle unchanged the way `isYouTubeSource` does.
 *
 * `mqdefault` (320x180) rather than `hqdefault`: the row it is drawn in is 64px wide on a
 * 400px screen, and the larger file buys nothing but bandwidth on a game client.
 */
export const thumbnailUrlFor = (videoId: string | null | undefined): string | null =>
  videoId && isVideoId(videoId) ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;

/**
 * Reduce whatever the player pasted to ids, or `null` if it is not a YouTube source.
 *
 * Accepts a bare id as well as a link — people paste both, and a bare id has already been
 * through the same validation a link's would be. A scheme-less `youtu.be/xyz` is accepted
 * too by prepending `https://`, which is what a browser address bar does; `parseUrl` below
 * is what decides whether the result is really a YouTube host, so guessing a scheme cannot
 * widen what is accepted.
 */
export function parseYouTubeSource(input: string): YouTubeSource | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A bare id, pasted without a link. Checked first, so the URL pattern never has to
  // decide whether an id is also a hostname.
  if (VIDEO_ID.test(trimmed)) return { videoId: trimmed, playlistId: null };

  const match = YOUTUBE_URL.exec(trimmed);
  if (!match) return null;

  const segments = (match[1] ?? '').split('/').map(decodeSegment).filter(Boolean);
  const query = parseQuery(match[2] ?? '');

  // `?v=` on /watch, and on music.youtube.com's /watch, which is the same shape.
  let videoId = pick(query.v, VIDEO_ID);

  // `youtu.be/ID` — the id is the whole path.
  if (!videoId && SHORT_HOST.test(trimmed)) videoId = pick(segments[0], VIDEO_ID);

  // `/embed/ID`, `/shorts/ID`, `/live/ID`, `/v/ID`.
  if (!videoId && segments.length >= 2 && ID_IN_PATH.has(segments[0].toLowerCase())) {
    videoId = pick(segments[1], VIDEO_ID);
  }

  const playlistId = pick(query.list, PLAYLIST_ID);

  if (!videoId && !playlistId) return null;
  return { videoId, playlistId };
}

const pick = (value: string | null | undefined, shape: RegExp): string | null =>
  value && shape.test(value) ? value : null;

/**
 * `decodeURIComponent` throws on a lone `%`, and a throw is not an answer here. The raw
 * text is returned instead, which then fails the id shape — a value we could not decode is
 * a value we are not going to interpolate.
 */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `?v=…&list=…` as a plain record.
 *
 * Only the first occurrence of a key wins, which is what `URLSearchParams.get` does too —
 * a second `v=` appended to a link must not be able to override the first.
 */
function parseQuery(search: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = Object.create(null) as Record<
    string,
    string | undefined
  >;
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeSegment(eq === -1 ? pair : pair.slice(0, eq));
    if (key in out) continue;
    out[key] = eq === -1 ? '' : decodeSegment(pair.slice(eq + 1));
  }
  return out;
}
