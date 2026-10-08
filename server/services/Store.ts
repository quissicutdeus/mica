// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { CONVAR_UNSET, resolveAddonConfig } from '@mica/shared/addonConfig';
import { storeContract, type StoreCatalogResult } from '@mica/shared/contracts/store';
import { SDK_CONTRACT_VERSION } from '../../sdk/version';

/**
 * The Store's add-on catalog, fetched by the server on the phones' behalf (MICA-237).
 *
 * A phone used to fetch the catalog itself, which told the catalog's host the IP address of
 * every player on the server. With the project's public catalog on by default, that host is
 * ours, so the server asks instead and every phone gets the server's cached copy: the host
 * sees one server, never a player.
 *
 * No table and no declaration, for Bank's reason: nothing here is micaOS data. The service
 * belongs to the Store app (`app: 'store'`) because the Store is the only thing that reads the
 * catalog — to list, install and update-check add-ons — so an owner who switches the Store off
 * also stops this server fetching a third party's URL for players who can no longer open it.
 * Add-ons already installed keep running either way; they rehydrate from storage, not from
 * the catalog.
 *
 * The fetch is held to the same rules the phone applied, and one more: **https only**, the
 * catalog's host must be in the resolved allowlist, and **a redirect is refused** — following
 * one would fetch from a host the allowlist never named. The body is capped and must be a
 * JSON array; what is inside it is not validated here. The phone validates every entry with
 * `isCatalogEntry` and re-hashes every bundle, as it always did, so relaying the JSON changes
 * who asks, not what is trusted.
 *
 * A failure answers `unavailable` and is written to the console once per failure window,
 * naming the URL and the reason. It never reaches a player's toast: the answer is data, and
 * the Store says "unavailable" in its own words.
 */
const app = new ServiceEndpoint<never, typeof storeContract>('store', null, {
  app: 'store',
  contract: storeContract,
  // Per citizen, and the shell reads the catalog at boot on either device (MICA-264).
  devices: ['phone', 'tablet'],
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

/** A successful catalog is reused for ten minutes. */
export const CATALOG_TTL_MS = 10 * 60_000;
/** A failed one is not retried for a minute, so a dead host is not asked once per phone. */
export const CATALOG_FAILURE_TTL_MS = 60_000;
/** The whole request, body included. */
export const CATALOG_TIMEOUT_MS = 10_000;
/** A catalog is a list of small entries; a body past this is not one. */
export const CATALOG_MAX_BYTES = 1024 * 1024;

// The minimal shapes of Node's web globals this file uses, declared rather than pulling the
// DOM lib into the server program, as `lib/mediaHost.ts` does.
interface CatalogBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}
interface CatalogResponse {
  ok: boolean;
  status: number;
  redirected?: boolean;
  headers: { get(name: string): string | null };
  body: { getReader(): CatalogBodyReader } | null;
}
interface CatalogAbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}
declare const fetch: (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    redirect: 'error';
    signal: CatalogAbortSignal;
  }
) => Promise<CatalogResponse>;
declare const AbortController: new () => {
  readonly signal: CatalogAbortSignal;
  abort(reason?: unknown): void;
};
declare const TextDecoder: new () => { decode(input: Uint8Array): string };
declare const URL: new (input: string) => {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
};

/** Thrown for a refusal this file decides, so its message is the whole reason. */
class CatalogRefusal extends Error {}

type Cached = { entries: unknown[] | null; until: number };

/** The last answer per catalog URL: entries on success, `null` for a failure. */
const cache = new Map<string, Cached>();
/** What one fetch came to: the entries, or why there are none. */
type Outcome = { entries: unknown[] } | { reason: string };

/** The fetch in progress per catalog URL, shared by every caller that arrives meanwhile. */
const inFlight = new Map<string, Promise<Outcome>>();
/** The last failure written to the console per URL, so a window says it once. */
const warned = new Map<string, { reason: string; until: number }>();

/** Tests only: forget every cached answer, fetch in flight and warning. */
export const resetStoreCatalogForTests = (): void => {
  cache.clear();
  inFlight.clear();
  warned.clear();
};

/**
 * `url` fit for a log line: no userinfo, no query, no fragment.
 *
 * An operator can put a token in either place — `https://user:key@host/...` or `?token=` —
 * and the server console is read by more people than the convar file is. Done by hand rather
 * than through `URL`, because the one URL that most needs it is the one that failed to parse.
 * Anything before the last `@` in the authority goes, so a password that itself holds an `@`
 * is removed whole rather than half.
 */
export const redactCatalogUrl = (url: string): string => {
  const withoutQuery = url.split(/[?#]/, 1)[0];
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(withoutQuery)?.[0] ?? '';
  const rest = withoutQuery.slice(scheme.length);
  const pathAt = rest.search(/[/\\]/);
  const authority = pathAt === -1 ? rest : rest.slice(0, pathAt);
  const path = pathAt === -1 ? '' : rest.slice(pathAt);
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : authority.slice(at + 1);
  const trimmed = withoutQuery.length < url.length ? '?…' : '';
  return `${scheme}${at === -1 ? '' : '…@'}${host}${path}${trimmed}`;
};

/**
 * A failure's reason fit for a log line. A runtime error can quote the URL it was handed, as
 * given or normalised; any URL in the reason is redacted as `redactCatalogUrl` does.
 */
const redactReason = (reason: string): string =>
  reason.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (found) => redactCatalogUrl(found));

const warnFailure = (url: string, reason: string): void => {
  const last = warned.get(url);
  if (last && last.reason === reason && last.until > Date.now()) return;
  warned.set(url, { reason, until: Date.now() + CATALOG_FAILURE_TTL_MS });
  console.warn(
    `[micaOS] add-on catalog ${redactCatalogUrl(url)} is unavailable: ${redactReason(reason)}`
  );
};

/** Why `url` may not be fetched with this allowlist, or `null` when it may. */
const refusalOf = (url: string, hosts: readonly string[]): string | null => {
  let parsed: InstanceType<typeof URL>;
  try {
    parsed = new URL(url);
  } catch {
    return 'it is not a URL';
  }
  if (parsed.protocol !== 'https:') return 'only an https:// catalog is fetched';
  if (parsed.username !== '' || parsed.password !== '') {
    return 'a catalog URL may not carry credentials';
  }
  const host = parsed.hostname.toLowerCase();
  if (!hosts.includes(host)) {
    return `its host '${host}' is not in mica_addon_hosts`;
  }
  return null;
};

const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  // Node's fetch reports every network failure as `TypeError: fetch failed` and puts what
  // actually happened — the redirect, the refused connection — on `cause`.
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
};

/** Read the body to its end, refusing at the first byte past the cap. */
const readCapped = async (
  response: CatalogResponse,
  signal: CatalogAbortSignal
): Promise<string> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CATALOG_MAX_BYTES) {
    throw new CatalogRefusal(`the host declared ${declared} bytes, over the 1 MiB cap`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  // The timeout has to cover a body that stalls halfway, not only the headers.
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CATALOG_MAX_BYTES) {
        throw new CatalogRefusal('the body is over the 1 MiB cap');
      }
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

/** One request for the catalog: its entries, or a thrown reason. */
const fetchCatalog = async (url: string): Promise<unknown[]> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new CatalogRefusal(`no answer within ${CATALOG_TIMEOUT_MS / 1000} s`)),
    CATALOG_TIMEOUT_MS
  );
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // A redirect would reach a host the allowlist never named. Refused, not followed.
      redirect: 'error',
      signal: controller.signal
    });
    if (response.redirected) throw new CatalogRefusal('the host redirected');
    if (!response.ok) throw new CatalogRefusal(`the host answered ${response.status}`);

    const text = await readCapped(response, controller.signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CatalogRefusal('the body is not JSON');
    }
    if (!Array.isArray(parsed)) throw new CatalogRefusal('the body is not a JSON array');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The catalog at `url`, from the cache while it is fresh, or `null` when it is unavailable.
 *
 * The URL and allowlist are checked on every call, before the cache, so an owner narrowing
 * `mica_addon_hosts` on a running server is obeyed at once rather than after the cached copy
 * expires.
 */
export const catalogEntries = async (
  url: string,
  hosts: readonly string[]
): Promise<unknown[] | null> => {
  const refusal = refusalOf(url, hosts);
  if (refusal) {
    warnFailure(url, refusal);
    return null;
  }

  const cached = cache.get(url);
  if (cached && cached.until > Date.now()) return cached.entries;

  const outcome = await fetchAndCache(url);
  return 'entries' in outcome ? outcome.entries : null;
};

/**
 * Fetch `url` and cache the answer, or join the fetch already in flight for it. The one path
 * to the host, for a phone's `store:catalog` and the console's `micahttp catalog` alike.
 */
const fetchAndCache = (url: string): Promise<Outcome> => {
  const pending = inFlight.get(url);
  if (pending) return pending;

  // Settled in the same step that fills the cache, so no caller ever finds neither.
  const request = fetchCatalog(url).then(
    (entries): Outcome => {
      cache.set(url, { entries, until: Date.now() + CATALOG_TTL_MS });
      inFlight.delete(url);
      warned.delete(url);
      return { entries };
    },
    (error: unknown): Outcome => {
      const reason = reasonOf(error);
      cache.set(url, { entries: null, until: Date.now() + CATALOG_FAILURE_TTL_MS });
      inFlight.delete(url);
      warnFailure(url, reason);
      return { reason };
    }
  );
  inFlight.set(url, request);
  return request;
};

/** The two convars, resolved, at the moment they are asked. */
const catalogSetting = () =>
  // Literal names, per call: `convars.test.ts` reads the name at each call site, and a `set`
  // on a running server applies to the next request.
  resolveAddonConfig(
    GetConvar('mica_addon_catalog', CONVAR_UNSET),
    GetConvar('mica_addon_hosts', CONVAR_UNSET),
    SDK_CONTRACT_VERSION
  );

/** What `store:catalog` answers, read from the two convars at the moment it is asked. */
export const readCatalog = async (): Promise<StoreCatalogResult> => {
  const setting = catalogSetting();
  if (setting.state === 'off') return { status: 'off' };

  const entries = await catalogEntries(setting.catalogUrl, setting.hosts);
  return entries ? { status: 'ok', entries } : { status: 'unavailable' };
};

/**
 * What `micahttp catalog` found (MICA-322). Every `url` and `reason` is already redacted as
 * the console line would be, so a caller can print them as they are.
 */
export type CatalogRefresh =
  | { status: 'off' }
  | { status: 'refused'; state: 'default' | 'custom'; url: string; reason: string }
  | { status: 'ok'; state: 'default' | 'custom'; url: string; entries: unknown[] }
  | { status: 'unavailable'; state: 'default' | 'custom'; url: string; reason: string };

/**
 * Fetch the catalog now, past the cache, through the same checks and the same request a
 * phone's `store:catalog` makes, and answer what came of it rather than only logging it. A
 * success refills the cache, so every phone gets what the console just saw; a failure holds
 * phones off for the failure window as a phone's own failed fetch would. A fetch already in
 * flight is joined, not doubled.
 */
export const refreshCatalog = async (): Promise<CatalogRefresh> => {
  const setting = catalogSetting();
  if (setting.state === 'off') return { status: 'off' };
  const state = setting.state;
  const { catalogUrl, hosts } = setting;
  const url = redactCatalogUrl(catalogUrl);

  const refusal = refusalOf(catalogUrl, hosts);
  if (refusal) return { status: 'refused', state, url, reason: redactReason(refusal) };

  if (!inFlight.has(catalogUrl)) cache.delete(catalogUrl);
  const outcome = await fetchAndCache(catalogUrl);
  return 'entries' in outcome
    ? { status: 'ok', state, url, entries: outcome.entries }
    : { status: 'unavailable', state, url, reason: redactReason(outcome.reason) };
};

app.registerEvent('catalog', async () => readCatalog());
