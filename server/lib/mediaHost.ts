// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An external image host for photos, as an option. MICA-243.
 *
 * MICA-71 kept the bytes in MySQL and said what would change the answer; an owner whose
 * `mica_media` has grown past what they want to back up is that answer, so this is the
 * opt-in half: with `mica_media_upload_url` set, the server posts a photo's bytes to the
 * host and stores the URL it answers with, and `data` stays empty. Unset, nothing here runs
 * and the database path is byte for byte what it was.
 *
 * Four rules hold the design, and each is a place it could have gone wrong:
 *
 * - **The upload is server-side.** `mica_media_upload_header` usually carries an API key,
 *   and the only way it never reaches a client is that no client is ever handed it. Nothing
 *   in this file sends a convar anywhere but the host, and no log line prints the header's
 *   value. (It is read with `GetConvar`, so an owner who writes `setr` instead of `set`
 *   replicates it to every client themselves — the README says so.)
 * - **A host outage never costs a photo.** Every failure — refused, timed out, not JSON, a
 *   URL that fails the check below — answers `null`, and the caller stores the bytes in the
 *   database exactly as it would have without a host. Logged, never thrown.
 * - **A returned URL is not trusted into an `<img src>`.** It must be `https:`, on the
 *   configured host exactly, on the default port, with no credentials, no whitespace and
 *   nothing that could close a CSS `url('…')` — and it must fit `mica_media.url`. A host
 *   that answers anything else is treated as a failed upload.
 * - **A hosted file outlives no row that names it.** Deletion (`releaseHostedImages`) is
 *   asked only for a URL no remaining row references — a proximity drop copies the URL onto
 *   each recipient's row, so the sender's row expiring must not pull the picture out from
 *   under theirs. Every path that hard-deletes `mica_media` rows reads their URLs first and
 *   hands them here after (MICA-292): retention, both character purges and the orphan sweep.
 *   The one it cannot is a database-level `ON DELETE CASCADE` from the owner table, which
 *   `warnIfCascadeHidesHostedPhotos` says out loud at start.
 *
 * `server/tsconfig.json` has neither `dom` nor `@types/node` in scope (see
 * `DiscordWebhook.ts`), so the few runtime globals used here are declared below at the
 * narrowest shape this file needs. FXServer runs Node 22 (`node_version '22'`), which has
 * all of them.
 */

import { Database } from './Database';
import { SCHEMA_MIGRATIONS_TABLE } from './schemaSql';

export const UPLOAD_URL_CONVAR = 'mica_media_upload_url';
export const UPLOAD_HEADER_CONVAR = 'mica_media_upload_header';
export const UPLOAD_FIELD_CONVAR = 'mica_media_upload_field';
export const UPLOAD_RESPONSE_PATH_CONVAR = 'mica_media_upload_response_path';
export const IMAGE_HOST_CONVAR = 'mica_media_image_host';
export const DELETE_URL_CONVAR = 'mica_media_delete_url';

/** The multipart field the file travels in when `mica_media_upload_field` is unset. */
export const DEFAULT_UPLOAD_FIELD = 'file';
/** Where the URL is in the host's JSON reply when `mica_media_upload_response_path` is unset. */
export const DEFAULT_RESPONSE_PATH = 'url';

/**
 * How long one upload may take before the photo goes to the database instead.
 *
 * Well inside the NUI callback's own fifteen seconds, so a slow host costs the player a
 * slower shutter rather than a capture that times out and is lost on the client.
 */
export const UPLOAD_TIMEOUT_MS = 8_000;
/** Delete requests are background work, but one hung request must not hold a prune forever. */
export const DELETE_TIMEOUT_MS = 8_000;
/** Delete requests in flight at once during a prune. */
export const DELETE_CONCURRENCY = 8;
/** `mica_media.url` is `varchar(512)`; a longer URL would be truncated into a broken one. */
export const MAX_HOSTED_URL_LENGTH = 512;

interface HostResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
type HostFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    signal?: unknown;
    redirect?: 'error';
  }
) => Promise<HostResponse>;

declare const fetch: HostFetch;
declare const FormData: new () => {
  append(name: string, value: unknown, filename?: string): void;
};
declare const Blob: new (parts: unknown[], options?: { type?: string }) => unknown;
declare const AbortSignal: { timeout(ms: number): unknown };
declare const atob: (data: string) => string;
interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  href: string;
}
declare const URL: new (input: string) => ParsedUrl;

const said = new Set<string>();
/** A misconfiguration is said once per distinct problem, not once per photo. */
const warnOnce = (key: string, line: string): void => {
  if (said.has(key)) return;
  said.add(key);
  console.warn(line);
};

/** Image hosts this process has recorded, or read back from the ledger. See `rememberImageHost`. */
const knownHosts = new Set<string>();
/** Hosts whose ledger write has been attempted this process, so it is one statement per host. */
const persisted = new Set<string>();
/** Whether the ledger's hosts have been read into `knownHosts` yet. */
let ledgerRead = false;

/** Tests only: forget what has been said, and every host remembered. */
export const resetMediaHostForTests = (): void => {
  said.clear();
  knownHosts.clear();
  persisted.clear();
  ledgerRead = false;
};

/**
 * A convar's value, trimmed. Each call site reads its own convar by its named constant,
 * never through a helper taking the name, because `convars.test.ts` reads the name at the
 * call site to hold the README to it.
 */
const clean = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

/** A plain DNS name, lower-cased. No port, no path, no wildcard. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** An RFC 7230 header name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A multipart field name an owner might plausibly configure. */
const FIELD_NAME = /^[A-Za-z0-9_.[\]-]{1,64}$/;

/** One segment of the response path: an object key or an array index. */
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Printable ASCII with nothing that could end an attribute or a CSS `url('…')`. A hosted
 * URL goes into `<img src>` and, via Settings, into a wallpaper's `url('…')`; a quote, a
 * paren or a backslash in it is never part of an honest image address.
 */
const SAFE_URL_CHARS = /^[\x21-\x7e]+$/;
const UNSAFE_URL_CHARS = /["'()<>\\`]/;

/** An `https:` URL with no credentials, or `null`. */
const parseHttps = (raw: string): ParsedUrl | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url;
  } catch {
    return null;
  }
};

/**
 * The host every hosted photo must come from, lower-cased: `mica_media_image_host`, or the
 * upload URL's own host when that is unset. `null` when neither names one.
 *
 * Separate from the upload URL on purpose, because the two are often different machines — an
 * API at `api.example.com` handing back files on `cdn.example.com` — and the one that matters
 * for rendering is where the files are. It stays meaningful with uploads turned off, so an
 * owner who stops uploading still gets the check and the CSP entry for the photos already
 * hosted.
 */
export const imageHost = (): string | null => {
  const configured = clean(GetConvar(IMAGE_HOST_CONVAR, '')).toLowerCase();
  if (configured) {
    if (HOSTNAME.test(configured)) return configured;
    warnOnce(
      `host:${configured}`,
      `[micamedia] ${IMAGE_HOST_CONVAR} is '${configured}', which is not a plain host name ` +
        '(no scheme, port or path). Hosted photos are refused until it is fixed.'
    );
    return null;
  }
  const upload = parseHttps(clean(GetConvar(UPLOAD_URL_CONVAR, '')));
  return upload && HOSTNAME.test(upload.hostname) ? upload.hostname : null;
};

/**
 * The origin the phone may draw hosted photos from, for the add-on CSP's `img-src`. `null`
 * when there is no image host. Only ever `https://<host>` — never a path, never a wildcard.
 */
export const imageHostOrigin = (): string | null => {
  const host = imageHost();
  return host ? `https://${host}` : null;
};

/**
 * `raw` as a URL safe to store and render, or `null`.
 *
 * `https:` on exactly the configured host, default port, no credentials, nothing but
 * printable ASCII that cannot close an attribute or a CSS `url()`, and short enough for the
 * column. Normalised through `URL` so what is stored is what was checked.
 */
export const validateHostedUrl = (
  raw: unknown,
  host: string | null = imageHost()
): string | null => {
  if (!host || typeof raw !== 'string') return null;
  if (raw.length > MAX_HOSTED_URL_LENGTH) return null;
  if (!SAFE_URL_CHARS.test(raw) || UNSAFE_URL_CHARS.test(raw)) return null;
  const url = parseHttps(raw);
  if (!url || url.hostname !== host || url.port !== '') return null;
  const href = url.href;
  if (href.length > MAX_HOSTED_URL_LENGTH || UNSAFE_URL_CHARS.test(href)) return null;
  return href;
};

/**
 * The ledger id recording that photos were once uploaded to, or served from, `host`. MICA-292.
 *
 * `validateHostedUrl` asks about the host configured **now**, so once an owner points
 * `mica_media_image_host` somewhere else every row still naming the old host stops counting
 * as hosted: never released, never even counted in the line that says files were left. A
 * row's URL is "ours" if its host was an image host when it was written, and the only
 * durable record of that is one written at the time. `mica_media.url` cannot carry it —
 * `AddMedia` and the importer write arbitrary `http(s)` hotlinks there too, so "any https
 * URL" would count a Tenor GIF as a photo of ours — and a column would be a schema change.
 *
 * So the host is recorded in `mica_schema_migrations`, the server-owned `id → timestamp`
 * table `contentRetention.ts` already keeps its grace markers in, for the reason given there:
 * the migration runner only asks which on-disk ids are missing from it, so an id no file
 * carries is never read as a migration, and `mediahost:` cannot collide with `NNNN_name`.
 */
const HOST_MARKER_PREFIX = 'mediahost:';
/** The ledger's `id` is `varchar(255)`; a host that would not fit is not recorded. */
const MAX_MARKER_LENGTH = 255;

/**
 * Record that `host` is an image host micaOS has used. Once per host per process; never
 * throws, because it runs beside an upload and at resource start and neither may fail on it.
 *
 * Remembered in memory before the write, so this process counts the host even when the
 * ledger cannot be written (`micaschema apply` not yet run), and says so once.
 */
export const rememberImageHost = async (host: string | null): Promise<void> => {
  if (!host || !HOSTNAME.test(host)) return;
  knownHosts.add(host);
  if (persisted.has(host)) return;
  persisted.add(host);
  const id = `${HOST_MARKER_PREFIX}${host}`;
  if (id.length > MAX_MARKER_LENGTH) return;
  try {
    await Database.query(`INSERT IGNORE INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`, [
      id
    ]);
  } catch (error) {
    warnOnce(
      'ledger-write',
      `[micamedia] could not record ${host} as an image host in ${SCHEMA_MIGRATIONS_TABLE} ` +
        `(${reasonOf(error)}); run micaschema apply. Until it is recorded, photos on it are ` +
        `not counted once ${IMAGE_HOST_CONVAR} points elsewhere.`
    );
  }
};

/**
 * Every image host micaOS has recorded, lower-cased: the ledger's, read once per process, plus
 * any this process remembered since. Answers what it has when the ledger cannot be read, and
 * tries the read again next time.
 */
export const recordedImageHosts = async (): Promise<ReadonlySet<string>> => {
  if (!ledgerRead) {
    try {
      const rows = await Database.query<{ id: unknown }[]>(
        `SELECT \`id\` FROM \`${SCHEMA_MIGRATIONS_TABLE}\` WHERE \`id\` LIKE ?`,
        [`${HOST_MARKER_PREFIX}%`]
      );
      if (!Array.isArray(rows)) throw new Error('not a result set');
      for (const row of rows) {
        const id = String(row.id);
        if (!id.startsWith(HOST_MARKER_PREFIX)) continue;
        const host = id.slice(HOST_MARKER_PREFIX.length);
        if (HOSTNAME.test(host)) knownHosts.add(host);
      }
      ledgerRead = true;
    } catch (error) {
      warnOnce(
        'ledger-read',
        `[micamedia] could not read former image hosts from ${SCHEMA_MIGRATIONS_TABLE} ` +
          `(${reasonOf(error)}); photos left on one are not counted until it can be read.`
      );
    }
  }
  return knownHosts;
};

/** `Name: value` from `mica_media_upload_header`, or `undefined` when unset, or `null` when bad. */
const parseHeader = (): { name: string; value: string } | null | undefined => {
  const raw = clean(GetConvar(UPLOAD_HEADER_CONVAR, ''));
  if (!raw) return undefined;
  const colon = raw.indexOf(':');
  const name = colon > 0 ? raw.slice(0, colon).trim() : '';
  const value = colon > 0 ? raw.slice(colon + 1).trim() : '';
  if (!HEADER_NAME.test(name) || value.length === 0 || /[\r\n]/.test(value)) {
    // The value is the secret, so it is never echoed — not even to say what was wrong with it.
    warnOnce(
      'header',
      `[micamedia] ${UPLOAD_HEADER_CONVAR} is not 'Name: value'. Uploads are off until it is ` +
        'fixed, so photos stay in the database.'
    );
    return null;
  }
  return { name, value };
};

interface UploadConfig {
  url: string;
  host: string;
  header?: { name: string; value: string };
  field: string;
  path: string[];
}

/**
 * Everything an upload needs, read fresh on every photo so a `set` from the live console takes
 * effect on the next capture. `null` when uploads are off — unset, or configured in a way
 * this refuses to guess about, which is said once.
 */
export const uploadConfig = (): UploadConfig | null => {
  const rawUrl = clean(GetConvar(UPLOAD_URL_CONVAR, ''));
  if (!rawUrl) return null;

  const upload = parseHttps(rawUrl);
  if (!upload) {
    warnOnce(
      `url:${rawUrl}`,
      `[micamedia] ${UPLOAD_URL_CONVAR} must be an https:// address with no credentials in ` +
        'it. Uploads are off until it is fixed, so photos stay in the database.'
    );
    return null;
  }

  const host = imageHost();
  if (!host) {
    warnOnce(
      'nohost',
      `[micamedia] no image host could be worked out; set ${IMAGE_HOST_CONVAR}. Uploads are ` +
        'off until it is, so photos stay in the database.'
    );
    return null;
  }

  const header = parseHeader();
  if (header === null) return null;

  let field = clean(GetConvar(UPLOAD_FIELD_CONVAR, '')) || DEFAULT_UPLOAD_FIELD;
  if (!FIELD_NAME.test(field)) {
    warnOnce(
      `field:${field}`,
      `[micamedia] ${UPLOAD_FIELD_CONVAR} '${field}' is not a usable field name; ` +
        `using '${DEFAULT_UPLOAD_FIELD}'.`
    );
    field = DEFAULT_UPLOAD_FIELD;
  }

  const rawPath = clean(GetConvar(UPLOAD_RESPONSE_PATH_CONVAR, '')) || DEFAULT_RESPONSE_PATH;
  const path = rawPath.split('.');
  if (!path.every((segment) => PATH_SEGMENT.test(segment))) {
    warnOnce(
      `path:${rawPath}`,
      `[micamedia] ${UPLOAD_RESPONSE_PATH_CONVAR} '${rawPath}' is not a dot path like ` +
        "'data.url'. Uploads are off until it is fixed, so photos stay in the database."
    );
    return null;
  }

  return { url: upload.href, host, header, field, path };
};

/** Follow `path` into a parsed JSON reply. Own properties only, so `__proto__` finds nothing. */
export const valueAtPath = (root: unknown, path: readonly string[]): unknown => {
  let node: unknown = root;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
};

/** The image types the camera and `AddMedia` produce, and the extension each is filed under. */
const EXTENSION_OF: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const DATA_URI = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

/** What an upload answers with. */
export interface HostedImage {
  url: string;
  mimeType: string;
  /**
   * The size of the file that was posted, in bytes (MICA-293). Counted here from what was
   * sent rather than read from the host's reply: every host reports it differently or not at
   * all, and this is the number the owner's storage actually received.
   */
  bytes: number;
}

/** Why an upload was not used, for the one log line that says so. */
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/**
 * Post one photo to the host and answer with the URL to store, or `null` to store the bytes.
 *
 * `null` without a word when uploads are off or `dataUri` is not an image data URI — both are
 * the ordinary database path. `null` with one log line for every failure once an upload was
 * attempted, and the caller writes the bytes to the database as it always did: **a host
 * outage is never a lost photo.**
 */
export const uploadImage = async (dataUri: unknown): Promise<HostedImage | null> => {
  if (typeof dataUri !== 'string') return null;
  const config = uploadConfig();
  if (!config) return null;

  const match = DATA_URI.exec(dataUri);
  if (!match) return null;
  const [, mimeType, base64] = match;

  const fail = (why: string): null => {
    console.warn(
      `[micamedia] upload to ${config.host} failed (${why}); the photo was stored in the ` +
        'database instead.'
    );
    return null;
  };

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    const form = new FormData();
    form.append(
      config.field,
      new Blob([bytes], { type: mimeType }),
      `mica-${Date.now()}.${EXTENSION_OF[mimeType]}`
    );

    const headers: Record<string, string> = {};
    if (config.header) headers[config.header.name] = config.header.value;

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      // A redirect would carry the API-key header to wherever it points. Refuse it: the
      // upload fails and the photo goes to the database.
      redirect: 'error'
    });
    if (!response.ok) return fail(`the host answered ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail('the reply was not JSON');
    }

    const returned = valueAtPath(body, config.path);
    if (typeof returned !== 'string') {
      return fail(`no URL at '${config.path.join('.')}' in the reply`);
    }
    const url = validateHostedUrl(returned, config.host);
    if (!url) {
      return fail(`the returned URL is not an https address on ${config.host} that fits`);
    }
    // So this file is still counted as ours after the host changes (MICA-292).
    void rememberImageHost(config.host);
    return { url, mimeType, bytes: bytes.length };
  } catch (error) {
    return fail(reasonOf(error));
  }
};

/** The delete request for one hosted URL, or `null` when the template cannot produce one. */
const deleteRequestUrl = (template: string, url: string): string | null => {
  const name = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  const built = template
    .replaceAll('{url}', encodeURIComponent(url))
    .replaceAll('{name}', encodeURIComponent(name));
  return parseHttps(built) ? built : null;
};

export interface ReleaseOutcome {
  /** Deleted on the host. */
  deleted: number;
  /** The host refused, or the request failed. Left on the host. */
  failed: number;
  /** No delete endpoint configured. Left on the host. */
  unconfigured: number;
  /**
   * On an image host micaOS used before the current one, keyed by host. Left there: the
   * delete URL configured now is the current host's, and handing it another host's file
   * would at best do nothing and at worst delete an unrelated file of the same name.
   */
  formerHost: Record<string, number>;
}

/** URLs per reference check, so a large release is several bounded statements, not one. */
export const RELEASE_CHECK_BATCH = 500;

/**
 * Ask the host to delete files no row references any more. MICA-243's half of retention.
 *
 * Only URLs that pass `validateHostedUrl` are deleted — a hotlinked GIF `AddMedia` stored from
 * somebody else's CDN is not ours to delete. Of those, only URLs no remaining `mica_media`
 * row names: a proximity drop copies a URL onto every recipient's row, and the sender's copy
 * aging out first must not take the picture from theirs. Callers call this **after** their
 * delete, so the rows that went are already gone from that check.
 *
 * An `https:` URL on a host micaOS recorded as an image host earlier (`rememberImageHost`),
 * but that is not the current one, goes through the same check and, unreferenced, is counted
 * under `formerHost` and never requested (MICA-292): the delete URL configured now belongs to
 * the current host, and guessing one for the old host is how an unrelated file gets deleted.
 *
 * With no `mica_media_delete_url` the files are counted and left, and the caller says so —
 * a host with no delete API is a real configuration, and silence would read as a clean-up.
 *
 * Never throws: a host outage must not fail the prune whose rows are already deleted.
 */
export const releaseHostedImages = async (
  candidates: readonly unknown[]
): Promise<ReleaseOutcome> => {
  const outcome: ReleaseOutcome = { deleted: 0, failed: 0, unconfigured: 0, formerHost: {} };
  const distinct = [
    ...new Set(candidates.filter((c): c is string => typeof c === 'string' && c !== ''))
  ];
  const current = imageHost();
  const hosted = distinct.filter((url) => validateHostedUrl(url, current) !== null);

  // The ledger is asked only when some https URL is not the current host's, so a release of
  // nothing but current-host photos costs no extra statement.
  const former = new Map<string, string>();
  const onCurrentHost = new Set(hosted);
  const others = distinct.filter((url) => !onCurrentHost.has(url));
  if (others.some((url) => parseHttps(url) !== null)) {
    const recorded = await recordedImageHosts();
    for (const url of others) {
      const host = parseHttps(url)?.hostname.toLowerCase();
      if (host && host !== current && recorded.has(host)) former.set(url, host);
    }
  }
  const considered = [...hosted, ...former.keys()];
  if (considered.length === 0) return outcome;

  const still = new Set<string>();
  try {
    for (let i = 0; i < considered.length; i += RELEASE_CHECK_BATCH) {
      const batch = considered.slice(i, i + RELEASE_CHECK_BATCH);
      const rows = await Database.query<{ url: string }[]>(
        `SELECT DISTINCT \`url\` FROM \`mica_media\` ` +
          `WHERE \`url\` IN (${batch.map(() => '?').join(', ')})`,
        batch
      );
      for (const row of Array.isArray(rows) ? rows : []) still.add(String(row.url));
    }
  } catch (error) {
    // Unsure what is still referenced, so nothing is deleted: a file left behind costs
    // storage, a file deleted under a live row costs somebody a photo.
    console.error('[micamedia] could not check which hosted photos are still in use:', error);
    outcome.failed = considered.length;
    return outcome;
  }

  for (const [url, host] of former) {
    if (!still.has(url)) outcome.formerHost[host] = (outcome.formerHost[host] ?? 0) + 1;
  }
  const unreferenced = hosted.filter((url) => !still.has(url));
  if (unreferenced.length === 0) return outcome;

  const template = clean(GetConvar(DELETE_URL_CONVAR, ''));
  if (!template) {
    outcome.unconfigured = unreferenced.length;
    return outcome;
  }
  if (!parseHttps(template.replaceAll('{url}', 'x').replaceAll('{name}', 'x'))) {
    warnOnce(
      `delete:${template}`,
      `[micamedia] ${DELETE_URL_CONVAR} must be an https:// address; hosted photos are left ` +
        'on the host until it is fixed.'
    );
    outcome.unconfigured = unreferenced.length;
    return outcome;
  }

  const header = parseHeader();
  const headers: Record<string, string> = {};
  if (header) headers[header.name] = header.value;

  const deleteOne = async (url: string): Promise<void> => {
    const target = deleteRequestUrl(template, url);
    if (!target) {
      outcome.failed += 1;
      return;
    }
    try {
      const response = await fetch(target, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
        // Same reason as the upload: the header must not follow a redirect off the host.
        redirect: 'error'
      });
      // 404 is success here: the file is already gone, which is the state asked for.
      if (response.ok || response.status === 404) outcome.deleted += 1;
      else outcome.failed += 1;
    } catch {
      outcome.failed += 1;
    }
  };

  for (let i = 0; i < unreferenced.length; i += DELETE_CONCURRENCY) {
    await Promise.all(unreferenced.slice(i, i + DELETE_CONCURRENCY).map(deleteOne));
  }
  return outcome;
};

/**
 * Say what a release did, in the one line an owner reads. Silent when nothing was hosted.
 *
 * `unconfigured` is a warning rather than a note: those files are on somebody's bill and
 * nothing will ever remove them unless an owner acts.
 */
export const reportRelease = (label: string, outcome: ReleaseOutcome): void => {
  if (outcome.deleted > 0) {
    console.log(`[${label}] deleted ${outcome.deleted} hosted photo(s) from the image host.`);
  }
  if (outcome.failed > 0) {
    console.warn(
      `[${label}] ${outcome.failed} hosted photo(s) could not be deleted from the image host ` +
        'and are left there; their rows are already gone.'
    );
  }
  if (outcome.unconfigured > 0) {
    console.warn(
      `[${label}] ${outcome.unconfigured} hosted photo(s) no longer belong to any row but ` +
        `${DELETE_URL_CONVAR} is not set, so they are left on the image host.`
    );
  }
  for (const [host, count] of Object.entries(outcome.formerHost)) {
    // Host and count only, never the URLs: they are the addresses of a deleted character's
    // photos, and a console is often piped somewhere more public than the database.
    console.warn(
      `[${label}] ${count} hosted photo(s) on ${host}, a former image host, no longer belong ` +
        `to any row. micaOS only deletes from the current one (${IMAGE_HOST_CONVAR}), so ` +
        `they are left on ${host}; remove them there if they should not stay reachable.`
    );
  }
};

/**
 * Say at start, once, when `mica_media` rows can vanish inside the database. MICA-292.
 *
 * On qb, `mica.sql` gives `mica_media.citizenid` a `FOREIGN KEY … ON DELETE CASCADE` onto
 * `players`, so a framework deleting a character takes their photo rows in the same
 * statement, without micaOS running a line. For a photo in the database that is the cleanup
 * working. For a hosted photo it is a leak: the row that named the file is gone before
 * anything could read its URL, nothing is left for the orphan sweep to find, and the file
 * stays publicly reachable at an address nobody will ever look up again. Without a listing
 * API on the host — which `mica_media_upload_url` does not promise — micaOS cannot find it.
 *
 * What an owner can do is order their deletion: trigger `mica:server:shell:characterDeleted`
 * (or the media-only one) **before** the framework deletes the character, and the purge
 * reads the URLs, deletes the rows and releases the files; the cascade then has nothing
 * left to take. This says so when there is an image host and the table carries a cascading
 * constraint, and answers whether it did. Never throws; a check it cannot run is said too,
 * rather than read as "no cascade".
 */
export const warnIfCascadeHidesHostedPhotos = async (table: string): Promise<boolean> => {
  const host = imageHost();
  if (!host) return false;
  let cascades: number;
  try {
    const rows = await Database.query<{ n: number | string }[]>(
      'SELECT COUNT(*) AS `n` FROM information_schema.REFERENTIAL_CONSTRAINTS ' +
        "WHERE `CONSTRAINT_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? AND `DELETE_RULE` = 'CASCADE'",
      [table]
    );
    cascades = Number(Array.isArray(rows) && rows.length > 0 ? rows[0].n : Number.NaN);
    if (!Number.isFinite(cascades)) throw new Error('not a count');
  } catch (error) {
    console.warn(
      `[micamedia] could not check whether ${table} cascades from the owner table ` +
        `(${reasonOf(error)}). If it does, a character your framework deletes leaves their ` +
        `hosted photos on ${host}; see the README's image host section.`
    );
    return false;
  }
  if (cascades === 0) return false;
  console.warn(
    `[micamedia] ${table} is deleted by ON DELETE CASCADE when your framework deletes a ` +
      `character, inside the database, so micaOS never sees those rows' URLs and their ` +
      `hosted photos stay on ${host}. Trigger mica:server:shell:characterDeleted before the ` +
      'character is deleted to release them; see the README.'
  );
  return true;
};
