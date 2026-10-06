// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The add-on dev loop's shared vocabulary (MICA-311).
 *
 * An author runs `pnpm dev` in the add-on template, which serves the bundle and a catalog entry
 * from loopback. A phone shell built to allow it (Vite `DEV`, or `VITE_MICA_ADDON_DEV=1`) reads
 * `?addonDev=<base>`, fetches `${base}mica-dev.json`, and mounts the bundle through the normal
 * sandboxed add-on path. This file is what both ends agree on: the names, and the one check
 * that decides whether a base is loopback at all.
 */

/** The phone's query parameter carrying the dev server's base URL. */
export const ADDON_DEV_QUERY = 'addonDev';

/** The catalog entry the template's dev server writes beside the bundle. */
export const ADDON_DEV_ENTRY = 'mica-dev.json';

/**
 * Carried as a runtime string by the shell's dev-add-on path, so a build check can scan a game
 * build for it: present there means the loopback path shipped where it must never run.
 */
export const MICA_DEV_ADDON_MARKER = 'mica-dev-addon';

/**
 * Carried as a runtime string by the in-frame service mock (`@mica/sdk/dev`), so a production
 * add-on bundle can be scanned for it: present there means the mock shipped to players.
 */
export const MICA_ADDON_MOCK_MARKER = 'mica-addon-mock';

/** The only hostnames a dev add-on may come from, as `URL#hostname` spells them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Far beyond any loopback base a person types; a bound so the parser never sees a flood. */
const MAX_BASE_LENGTH = 2048;

/**
 * The parts of a WHATWG `URL` this file reads and hands back.
 *
 * Described here rather than named as `URL`: `shared/` is compiled by the client and server
 * targets too, whose type sets (`es2021`/`es2023` plus the FiveM runtime) have no `URL` global,
 * and a `/// <reference lib="dom" />` would hand all of `client/` and `server/` the DOM. A real
 * `URL` satisfies this structurally, so a caller in the browser treats it as one; build another
 * from `base.href` when a full `URL` is wanted.
 */
export interface ParsedUrl {
  readonly href: string;
  readonly origin: string;
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
  toString(): string;
}

type UrlConstructor = new (url: string, base?: string) => ParsedUrl;

/**
 * The runtime's URL parser, or undefined where there is none. Only the browser and Node call
 * into this file, both of which have one; anywhere else every URL is refused rather than
 * judged by a hand-written parser that would disagree with the browser's.
 */
const parser = (): UrlConstructor | undefined =>
  (globalThis as unknown as { URL?: UrlConstructor }).URL;

export type LoopbackBaseCheck = { ok: true; base: ParsedUrl } | { ok: false; reason: string };

/**
 * Decide whether `raw` is a dev server base on this machine, and return it parsed.
 *
 * **Judged after WHATWG parsing, never on the raw text.** The browser fetches the URL it
 * parses, not the string it was given, so the parsed hostname is the host that is reached:
 * `http://127.1/`, `http://0x7f.0.0.1/` and `HTTP://LOCALHOST/` are all `127.0.0.1` or
 * `localhost` by the time a request leaves, and are accepted as exactly that. The other side
 * holds too — anything that parses to a host outside the three spellings is refused, however
 * it was dressed up. A caller must therefore use `base.href` from here on, never `raw`.
 *
 * Refused: a protocol other than `http:`/`https:`; any hostname but `localhost`, `127.0.0.1`
 * or `[::1]` (so `127.0.0.2`, `0.0.0.0`, `localhost.`, `x.localhost`, `localhost.evil.com` and
 * an IPv4-mapped `[::ffff:7f00:1]`); a username or password; a query or a fragment, even an
 * empty `?` or `#`; a path not ending in `/`. Any port.
 */
export function parseLoopbackBase(raw: string): LoopbackBaseCheck {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'No dev add-on URL was given.' };
  }
  if (raw.length > MAX_BASE_LENGTH) {
    return { ok: false, reason: `A dev add-on URL is at most ${MAX_BASE_LENGTH} characters.` };
  }
  const Url = parser();
  if (!Url) return { ok: false, reason: 'This runtime has no URL parser.' };
  let url: ParsedUrl;
  try {
    url = new Url(raw);
  } catch {
    return { ok: false, reason: `'${raw}' is not a URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `A dev add-on is served over http or https, not ${url.protocol}` };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason: `'${url.hostname}' is not loopback. A dev add-on loads only from localhost, 127.0.0.1 or [::1].`
    };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'A dev add-on URL carries no username or password.' };
  }
  // An empty `?` or `#` leaves `search`/`hash` empty but stays in `href`, so compare the whole
  // serialization: a base is an origin and a path, and nothing else.
  if (url.href !== url.origin + url.pathname) {
    return { ok: false, reason: 'A dev add-on URL carries no query and no fragment.' };
  }
  if (!url.pathname.endsWith('/')) {
    return {
      ok: false,
      reason: `A dev add-on URL is a directory and ends in '/': ${url.origin}${url.pathname}/`
    };
  }
  return { ok: true, base: url };
}

/**
 * Whether `url` (absolute, or relative to `base`) lands on `base`'s own origin over the same
 * protocol. A `blob:` URL reports its creator's origin, so the protocol is compared as well.
 */
export function sameOriginAs(base: ParsedUrl, url: string | ParsedUrl): boolean {
  const Url = parser();
  if (!Url) return false;
  let resolved: ParsedUrl;
  try {
    resolved = new Url(typeof url === 'string' ? url : url.href, base.href);
  } catch {
    return false;
  }
  return resolved.protocol === base.protocol && resolved.origin === base.origin;
}
