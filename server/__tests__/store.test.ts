// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `store:catalog` (MICA-237): the server fetches the add-on catalog for the phones.
 *
 * `fetch` is stubbed per test, so nothing here reaches a network, and `Database` is mocked so
 * nothing reaches a connection. What no suite proves is a live FXServer's `fetch` and its TLS:
 * the stub stands in for Node's, with the same `redirect: 'error'` and abort contract.
 */
const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) => (src === 1 ? { citizenid: 'CID_CALLER', source: 1 } : null)
  }
}));

import {
  CATALOG_FAILURE_TTL_MS,
  CATALOG_MAX_BYTES,
  CATALOG_TIMEOUT_MS,
  CATALOG_TTL_MS,
  redactCatalogUrl,
  resetStoreCatalogForTests
} from '../services/Store';
import { __resetRateLimits } from '../lib/rateLimit';
import { publicAddonCatalogUrl } from '@mica/shared/addonConfig';
import { SDK_CONTRACT_VERSION } from '../../sdk/version';

const DEFAULT_URL = publicAddonCatalogUrl(SDK_CONTRACT_VERSION);
const CUSTOM_URL = 'https://store.example.com/catalog.json';
const ENTRY = { id: 'weather', name: 'Weather', version: '1.0.0' };

/** Set the two convars; a name left out is unset, so `GetConvar` hands back its default. */
const withConvars = (values: Record<string, string>): void => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in values ? values[name] : fallback;
};

const call = async (src = 1): Promise<unknown> => {
  (globalThis as any).source = src;
  (globalThis as any).emitNet = vi.fn();
  const handler = handlers.get('mica:server:store:catalog');
  if (!handler) throw new Error('no handler for store:catalog');
  await handler('cb-1', undefined);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

type Init = { redirect: string; signal: AbortSignal; method: string };

interface FakeBody {
  reader: { read: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  getReader: ReturnType<typeof vi.fn>;
}

/** A body that yields `chunks` in order, then ends. */
const bodyOf = (chunks: Uint8Array[]): FakeBody => {
  const queue = [...chunks];
  const reader = {
    read: vi.fn(async () =>
      queue.length > 0 ? { done: false, value: queue.shift() } : { done: true }
    ),
    cancel: vi.fn(async () => {})
  };
  return { reader, getReader: vi.fn(() => reader) };
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const response = (
  body: FakeBody | null,
  { status = 200, headers = {}, redirected = false } = {} as {
    status?: number;
    headers?: Record<string, string>;
    redirected?: boolean;
  }
) => ({
  ok: status >= 200 && status < 300,
  status,
  redirected,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  body
});

const jsonResponse = (value: unknown) => response(bodyOf([bytes(JSON.stringify(value))]));

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStoreCatalogForTests();
  __resetRateLimits();
  withConvars({});
  fetchMock = vi.fn(async () => jsonResponse([ENTRY]));
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

const fetchedUrl = (): string => fetchMock.mock.calls[0][0] as string;
const fetchInit = (): Init => fetchMock.mock.calls[0][1] as Init;
const warnings = (): string[] => warn.mock.calls.map((args) => String(args[0]));

describe('store:catalog — which catalog', () => {
  it('fetches the public catalog for this SDK contract when the convar was never set', async () => {
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchedUrl()).toBe(DEFAULT_URL);
    expect(DEFAULT_URL).toBe(`https://mica.gg/addons/sdk-${SDK_CONTRACT_VERSION}/catalog.json`);
  });

  it('allows mica.gg for the default catalog even when the owner listed other hosts', async () => {
    withConvars({ mica_addon_hosts: 'cdn.example.com' });
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    expect(fetchedUrl()).toBe(DEFAULT_URL);
  });

  it('fetches a custom catalog whose host the owner listed', async () => {
    withConvars({ mica_addon_catalog: CUSTOM_URL, mica_addon_hosts: 'store.example.com' });
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    expect(fetchedUrl()).toBe(CUSTOM_URL);
  });

  it('refuses a custom catalog whose host is not listed, without fetching it', async () => {
    withConvars({ mica_addon_catalog: CUSTOM_URL, mica_addon_hosts: 'cdn.example.com' });
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(CUSTOM_URL);
    expect(warnings()[0]).toContain("'store.example.com' is not in mica_addon_hosts");
  });

  it('refuses a custom catalog when no hosts are listed at all', async () => {
    withConvars({ mica_addon_catalog: CUSTOM_URL });
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers off for 'off', without fetching or warning", async () => {
    withConvars({ mica_addon_catalog: 'off', mica_addon_hosts: 'mica.gg' });
    expect(await call()).toEqual({ status: 'off' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers off for a convar set explicitly to empty', async () => {
    withConvars({ mica_addon_catalog: '' });
    expect(await call()).toEqual({ status: 'off' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a caller with no loaded character before anything is fetched', async () => {
    const reply = (await call(2)) as { key?: string };
    expect(reply.key).toBe('server.notAuthenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('store:catalog — what is fetched, and how', () => {
  it('fetches only https, even from a listed host', async () => {
    withConvars({
      mica_addon_catalog: 'http://store.example.com/catalog.json',
      mica_addon_hosts: 'store.example.com'
    });
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()[0]).toContain('only an https:// catalog is fetched');
  });

  it('refuses a URL carrying credentials', async () => {
    withConvars({
      mica_addon_catalog: 'https://user:pw@store.example.com/catalog.json',
      mica_addon_hosts: 'store.example.com'
    });
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks fetch to refuse a redirect rather than follow it', async () => {
    await call();
    expect(fetchInit().redirect).toBe('error');
    expect(fetchInit().method).toBe('GET');
  });

  it('answers unavailable, naming the redirect, when fetch refuses one', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
    );
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(DEFAULT_URL);
    expect(warnings()[0]).toContain('fetch failed: unexpected redirect');
  });

  it('refuses a response that was redirected anyway', async () => {
    fetchMock.mockResolvedValue(response(bodyOf([bytes('[]')]), { redirected: true }));
    expect(await call()).toEqual({ status: 'unavailable' });
  });

  it('answers unavailable for a non-2xx status', async () => {
    fetchMock.mockResolvedValue(response(bodyOf([bytes('[]')]), { status: 404 }));
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(warnings()[0]).toContain('the host answered 404');
  });

  it('accepts a body of exactly the cap', async () => {
    const text = `["${'a'.repeat(CATALOG_MAX_BYTES - 4)}"]`;
    expect(text.length).toBe(CATALOG_MAX_BYTES);
    fetchMock.mockResolvedValue(response(bodyOf([bytes(text)])));
    const reply = (await call()) as { status: string; entries: string[] };
    expect(reply.status).toBe('ok');
    expect(reply.entries[0]).toHaveLength(CATALOG_MAX_BYTES - 4);
  });

  it('stops reading at the first chunk past the cap, and cancels the rest', async () => {
    const half = new Uint8Array(CATALOG_MAX_BYTES / 2);
    const body = bodyOf([half, half, new Uint8Array(1), new Uint8Array(1)]);
    fetchMock.mockResolvedValue(response(body));
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(body.reader.read).toHaveBeenCalledTimes(3);
    expect(body.reader.cancel).toHaveBeenCalledTimes(1);
    expect(warnings()[0]).toContain('over the 1 MiB cap');
  });

  it('refuses a declared length over the cap without reading the body', async () => {
    const body = bodyOf([bytes('[]')]);
    fetchMock.mockResolvedValue(
      response(body, { headers: { 'content-length': String(CATALOG_MAX_BYTES + 1) } })
    );
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(body.getReader).not.toHaveBeenCalled();
  });

  it('refuses a body that is JSON but not an array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ apps: [ENTRY] }));
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(warnings()[0]).toContain('not a JSON array');
  });

  it('refuses a body that is not JSON', async () => {
    fetchMock.mockResolvedValue(response(bodyOf([bytes('<html>')])));
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(warnings()[0]).toContain('not JSON');
  });

  it('relays the entries unvalidated: the phone validates each one', async () => {
    const odd = [ENTRY, 42, null, { anything: true }];
    fetchMock.mockResolvedValue(jsonResponse(odd));
    expect(await call()).toEqual({ status: 'ok', entries: odd });
  });

  it('never puts the failure reason in the reply', async () => {
    fetchMock.mockRejectedValue(new Error('secret internal detail'));
    const reply = await call();
    expect(reply).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(reply)).not.toContain('secret');
  });
});

describe('store:catalog — what reaches the console', () => {
  const SECRETS = ['opuser', 's3cr3t', 't0ken', 'token=', 'frag'];

  /** Every line written to any console method during the test, as one string. */
  const consoleOutput = (): string => spies.flatMap((spy) => spy.mock.calls.flat()).join('\n');
  let spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    spies = [
      warn,
      ...(['log', 'info', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {})
      )
    ];
  });
  afterEach(() => {
    for (const spy of spies.slice(1)) spy.mockRestore();
  });

  const expectNoSecrets = (): void => {
    const output = consoleOutput();
    expect(output, 'nothing was logged, so this proves nothing').toContain('add-on catalog');
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  };

  it('redacts credentials and the query from a refused URL', async () => {
    withConvars({
      mica_addon_catalog: 'https://opuser:s3cr3t@store.example.com/catalog.json?token=t0ken#frag',
      mica_addon_hosts: 'store.example.com'
    });
    expect(await call()).toEqual({ status: 'unavailable' });
    expectNoSecrets();
    expect(consoleOutput()).toContain('https://…@store.example.com/catalog.json?…');
  });

  it('redacts a URL that does not even parse', async () => {
    withConvars({
      mica_addon_catalog: 'https://opuser:s3cr3t@[::bad/catalog.json?token=t0ken',
      mica_addon_hosts: 'store.example.com'
    });
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(consoleOutput()).toContain('it is not a URL');
    expectNoSecrets();
  });

  it('redacts the query from a host refusal', async () => {
    withConvars({ mica_addon_catalog: `${CUSTOM_URL}?token=t0ken` });
    expect(await call()).toEqual({ status: 'unavailable' });
    expectNoSecrets();
  });

  it('redacts the URL where a fetch failure quotes it back', async () => {
    const url = `${CUSTOM_URL}?token=t0ken`;
    withConvars({ mica_addon_catalog: url, mica_addon_hosts: 'store.example.com' });
    fetchMock.mockRejectedValue(new TypeError(`Failed to parse URL from ${url}`));
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(fetchedUrl()).toBe(url);
    expectNoSecrets();
  });

  it('redacts a failed fetch of a URL carrying a token', async () => {
    withConvars({
      mica_addon_catalog: `${CUSTOM_URL}?token=t0ken`,
      mica_addon_hosts: 'store.example.com'
    });
    fetchMock.mockResolvedValue(response(bodyOf([bytes('[]')]), { status: 500 }));
    expect(await call()).toEqual({ status: 'unavailable' });
    expectNoSecrets();
  });
});

describe('redactCatalogUrl', () => {
  it.each([
    ['https://store.example.com/catalog.json', 'https://store.example.com/catalog.json'],
    ['https://u:p@store.example.com/c.json', 'https://…@store.example.com/c.json'],
    ['https://u:p@ss@store.example.com/c.json', 'https://…@store.example.com/c.json'],
    ['https://store.example.com/c.json?token=x', 'https://store.example.com/c.json?…'],
    ['https://store.example.com/c.json#token', 'https://store.example.com/c.json?…'],
    ['u:p@store.example.com/c.json?k=v', '…@store.example.com/c.json?…'],
    ['https://u:p@store.example.com', 'https://…@store.example.com'],
    ['https://u:p@store.example.com\\c.json', 'https://…@store.example.com\\c.json']
  ])('%s → %s', (raw, redacted) => {
    expect(redactCatalogUrl(raw)).toBe(redacted);
  });
});

describe('store:catalog — the timeout', () => {
  /** A fetch that never answers on its own, and rejects when its signal aborts. */
  const hangingFetch = async (_url: string, init: Init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });

  it('gives up on a host that does not answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fetchMock.mockImplementation(hangingFetch);
    const pending = call();
    await vi.advanceTimersByTimeAsync(CATALOG_TIMEOUT_MS - 1);
    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(warnings()[0]).toContain('no answer within 10 s');
  });

  it('gives up on a body that stalls halfway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: bytes('[') })
        .mockImplementation(() => new Promise(() => {})),
      cancel: vi.fn(async () => {})
    };
    fetchMock.mockResolvedValue(response({ reader, getReader: vi.fn(() => reader) }));
    const pending = call();
    await vi.advanceTimersByTimeAsync(CATALOG_TIMEOUT_MS);
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('store:catalog — the cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  it('answers from the cache for ten minutes, then fetches again', async () => {
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    await vi.advanceTimersByTimeAsync(CATALOG_TTL_MS - 1);
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches per URL: a different catalog is its own fetch', async () => {
    await call();
    withConvars({ mica_addon_catalog: CUSTOM_URL, mica_addon_hosts: 'store.example.com' });
    await call();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([DEFAULT_URL, CUSTOM_URL]);
  });

  it('checks the allowlist before the cache, so narrowing it applies at once', async () => {
    withConvars({ mica_addon_catalog: CUSTOM_URL, mica_addon_hosts: 'store.example.com' });
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    withConvars({ mica_addon_catalog: CUSTOM_URL, mica_addon_hosts: 'cdn.example.com' });
    expect(await call()).toEqual({ status: 'unavailable' });
  });

  it('remembers a failure for a minute, and says it once', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await call()).toEqual({ status: 'unavailable' });
    await vi.advanceTimersByTimeAsync(CATALOG_FAILURE_TTL_MS - 1);
    expect(await call()).toEqual({ status: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toHaveLength(1);

    fetchMock.mockResolvedValue(jsonResponse([ENTRY]));
    await vi.advanceTimersByTimeAsync(1);
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says a refused host once per window, not once per phone', async () => {
    withConvars({ mica_addon_catalog: CUSTOM_URL });
    await call();
    await call();
    await call();
    expect(warnings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CATALOG_FAILURE_TTL_MS);
    await call();
    expect(warnings()).toHaveLength(2);
  });

  it('shares one fetch in flight between phones that ask at once', async () => {
    let answer: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

    // One `emitNet` for all three, since `call` would swap it per request.
    const emit = vi.fn();
    (globalThis as any).emitNet = emit;
    (globalThis as any).source = 1;
    const handler = handlers.get('mica:server:store:catalog')!;
    const pending = [handler('cb-1', undefined), handler('cb-2', undefined), handler('cb-3', {})];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(jsonResponse([ENTRY]));
    await Promise.all(pending);
    expect(emit.mock.calls.map((args) => [args[2], args[3]])).toEqual([
      ['cb-1', { status: 'ok', entries: [ENTRY] }],
      ['cb-2', { status: 'ok', entries: [ENTRY] }],
      ['cb-3', { status: 'ok', entries: [ENTRY] }]
    ]);
    expect(await call()).toEqual({ status: 'ok', entries: [ENTRY] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares a failure in flight the same way, and says it once', async () => {
    let fail: (reason: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    const emit = vi.fn();
    (globalThis as any).emitNet = emit;
    (globalThis as any).source = 1;
    const handler = handlers.get('mica:server:store:catalog')!;
    const pending = [handler('cb-1', undefined), handler('cb-2', undefined)];
    await vi.advanceTimersByTimeAsync(0);

    fail(new TypeError('fetch failed'));
    await Promise.all(pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls.map((args) => args[3])).toEqual([
      { status: 'unavailable' },
      { status: 'unavailable' }
    ]);
    expect(warnings()).toHaveLength(1);
  });
});
