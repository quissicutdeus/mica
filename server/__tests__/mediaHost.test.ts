// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetRetentionForTests } from '../lib/contentRetention';

/**
 * MICA-243: photos on an external image host, as an option.
 *
 * What each block is careful to prove, because each is a way this could pass while proving
 * nothing:
 *
 * - **The fallback is asserted on the insert, not on the absence of an error.** A create that
 *   answered success and wrote no bytes anywhere would satisfy "no error"; the row's own
 *   columns are what say the photo survived.
 * - **The secret is asserted absent from everything a client or a log could see**, not just
 *   present in the request that needed it.
 * - **Nothing is ever deleted from the host** (MICA-428): a refused insert keeps its uploaded
 *   file, and the prune and the purges send no request at all. `hostedCleanup.test.ts` drives
 *   every such path.
 *
 * `fetch` is stubbed per test: nothing here reaches a network, and `Database` is mocked so
 * nothing reaches MySQL either — which also means no SQL is evaluated, only inspected.
 */
const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previousNet = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousNet === 'function' ? previousNet(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CID_A', source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => 5,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {},
    ownerTable: () => ({ table: 'players', column: 'citizenid' })
  }
}));

import {
  imageHost,
  imageHostOrigin,
  resetMediaHostForTests,
  uploadImage,
  validateHostedUrl,
  valueAtPath
} from '../lib/mediaHost';
import '../services/Media';
import '../services/MediaHost';

const CREATE_EVENT = 'mica:server:media:create';
const IMAGE_HOST_EVENT = 'mica:server:shell:imageHost';

const SECRET = 'Bearer sk_live_do-not-leak';
const HOSTED = 'https://img.example.test/p/abc.webp';
const PHOTO = `data:image/webp;base64,${btoa('not really a webp')}`;

const call = async (event: string, data: unknown) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

const withConvars = (values: Record<string, string> = {}) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in values ? values[name] : fallback;
  (globalThis as any).GetConvarInt = (_name: string, fallback: number) => fallback;
};

/** A host that uploads to `api.` and serves from `img.`, the shape that needs both convars. */
const hosting = (extra: Record<string, string> = {}) =>
  withConvars({
    mica_media_upload_url: 'https://api.example.test/upload',
    mica_media_upload_header: `Authorization: ${SECRET}`,
    mica_media_image_host: 'img.example.test',
    ...extra
  });

type FetchCall = [
  string,
  { method: string; headers: Record<string, string>; body?: unknown; redirect?: string }
];
let fetchMock: ReturnType<typeof vi.fn>;
const replyWith = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    }
  });

/** Every string console.* was handed, so a leak anywhere in a log line is found. */
const logged = (): string =>
  [console.log, console.warn, console.error]
    .flatMap((fn) => (fn as any).mock.calls.flat())
    .map(String)
    .join('\n');

const lastInsert = () => {
  const [sql, params] = dbMock.insert.mock.calls.at(-1)!;
  return { sql: String(sql), params: params as unknown[] };
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockReset();
  dbMock.insert.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(99);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  withConvars();
  resetMediaHostForTests();
  resetRetentionForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateHostedUrl: nothing reaches an img src unchecked', () => {
  const host = 'img.example.test';

  it('accepts an https URL on exactly the configured host', () => {
    expect(validateHostedUrl(HOSTED, host)).toBe(HOSTED);
  });

  it.each([
    ['plain http', 'http://img.example.test/p/abc.webp'],
    ['another host', 'https://evil.test/p/abc.webp'],
    ['a subdomain of the host', 'https://x.img.example.test/p/abc.webp'],
    ['a host that merely ends the same', 'https://notimg.example.test/p/abc.webp'],
    ['a non-default port', 'https://img.example.test:8443/p/abc.webp'],
    ['credentials', 'https://user:pass@img.example.test/p/abc.webp'],
    ['a quote that could close url()', "https://img.example.test/p/a'b.webp"],
    ['a paren that could close url()', 'https://img.example.test/p/a)b.webp'],
    ['whitespace', 'https://img.example.test/p/a b.webp'],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a data: URI', 'data:image/png;base64,AAAA'],
    ['more than the column holds', `https://img.example.test/${'a'.repeat(520)}`]
  ])('refuses %s', (_why, url) => {
    expect(validateHostedUrl(url, host)).toBeNull();
  });

  it('refuses anything that is not a string, and everything when no host is configured', () => {
    expect(validateHostedUrl({ href: HOSTED }, host)).toBeNull();
    expect(validateHostedUrl(HOSTED, null)).toBeNull();
  });
});

describe('the image host and its origin', () => {
  it('defaults to the upload URL host when mica_media_image_host is unset', () => {
    withConvars({ mica_media_upload_url: 'https://Uploads.Example.test/api' });
    expect(imageHost()).toBe('uploads.example.test');
    expect(imageHostOrigin()).toBe('https://uploads.example.test');
  });

  it('is null with nothing configured, so the CSP gains nothing', () => {
    expect(imageHostOrigin()).toBeNull();
  });

  it('refuses a host with a scheme, port or wildcard rather than widening the CSP', () => {
    for (const bad of ['https://img.example.test', 'img.example.test:443', '*.example.test']) {
      withConvars({ mica_media_image_host: bad });
      expect(imageHostOrigin()).toBeNull();
    }
  });

  it('answers the shell action with the origin and nothing that is a secret', async () => {
    hosting();
    const reply = await call(IMAGE_HOST_EVENT, undefined);

    expect(reply).toEqual({ origin: 'https://img.example.test' });
    expect(JSON.stringify(reply)).not.toContain('sk_live');
    expect(JSON.stringify(reply)).not.toContain('/upload');
  });
});

describe('valueAtPath', () => {
  it('follows a dot path through objects and arrays', () => {
    expect(valueAtPath({ data: { link: 'x' } }, ['data', 'link'])).toBe('x');
    expect(valueAtPath({ files: [{ url: 'y' }] }, ['files', '0', 'url'])).toBe('y');
  });

  it('finds nothing through the prototype', () => {
    expect(valueAtPath({}, ['__proto__'])).toBeUndefined();
    expect(valueAtPath({}, ['constructor'])).toBeUndefined();
  });
});

describe('uploadImage', () => {
  it('does nothing at all when no upload URL is configured', async () => {
    expect(await uploadImage(PHOTO)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the bytes as multipart, with the header, and answers the checked URL', async () => {
    hosting({ mica_media_upload_field: 'image' });
    replyWith(200, { url: HOSTED });

    // `bytes` is the decoded file's size, the number the quota charges (MICA-293).
    expect(await uploadImage(PHOTO)).toEqual({
      url: HOSTED,
      mimeType: 'image/webp',
      bytes: 'not really a webp'.length
    });

    const [url, init] = fetchMock.mock.calls[0] as FetchCall;
    expect(url).toBe('https://api.example.test/upload');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: SECRET });
    const form = init.body as FormData;
    const file = form.get('image') as File;
    // The decoded bytes, not the base64 text: a host stores what it is sent.
    expect(await file.text()).toBe('not really a webp');
    expect(file.type).toBe('image/webp');
  });

  it('refuses to follow a redirect, which would carry the key off the host', async () => {
    hosting();
    replyWith(200, { url: HOSTED });

    await uploadImage(PHOTO);

    expect((fetchMock.mock.calls[0] as FetchCall)[1].redirect).toBe('error');
  });

  it('falls back to the database when the host answers with a redirect', async () => {
    hosting();
    // What undici does under `redirect: 'error'`.
    fetchMock.mockRejectedValue(new TypeError('fetch failed: unexpected redirect'));

    expect(await uploadImage(PHOTO)).toBeNull();
    expect(logged()).toMatch(/stored in the database instead/);
  });

  it('reads the URL from the configured response path', async () => {
    hosting({ mica_media_upload_response_path: 'data.link' });
    replyWith(200, { data: { link: HOSTED } });

    expect((await uploadImage(PHOTO))?.url).toBe(HOSTED);
  });

  it('does not post what is not an image data URI', async () => {
    hosting();
    expect(await uploadImage('{"x":1,"y":2,"z":3}')).toBeNull();
    expect(await uploadImage('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the host refuses', () => replyWith(503, {})],
    ['the reply is not JSON', () => replyWith(200, new SyntaxError('bad json'))],
    ['the reply has no URL at the path', () => replyWith(200, { link: HOSTED })],
    ['the URL is on another host', () => replyWith(200, { url: 'https://evil.test/a.webp' })],
    ['the URL is plain http', () => replyWith(200, { url: 'http://img.example.test/a.webp' })],
    ['the request throws or times out', () => fetchMock.mockRejectedValue(new Error('timeout'))]
  ])('answers null and logs when %s', async (_why, arrange) => {
    hosting();
    arrange();

    expect(await uploadImage(PHOTO)).toBeNull();
    expect(logged()).toMatch(/upload to img\.example\.test failed/);
    expect(logged()).toMatch(/stored in the database instead/);
  });

  it('never writes the header value to the console, even when it is malformed', async () => {
    hosting();
    replyWith(500, {});
    await uploadImage(PHOTO);

    withConvars({
      mica_media_upload_url: 'https://api.example.test/upload',
      mica_media_upload_header: 'no-colon-sk_live_do-not-leak'
    });
    resetMediaHostForTests();
    expect(await uploadImage(PHOTO)).toBeNull();

    expect(logged()).not.toContain('sk_live');
  });

  it('turns uploads off, loudly, for a malformed header rather than posting without it', async () => {
    withConvars({
      mica_media_upload_url: 'https://api.example.test/upload',
      mica_media_upload_header: 'Authorization'
    });

    expect(await uploadImage(PHOTO)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toContain('mica_media_upload_header');
  });

  it('refuses a plain-http upload URL, which would send the key in the clear', async () => {
    withConvars({
      mica_media_upload_url: 'http://api.example.test/upload',
      mica_media_upload_header: `Authorization: ${SECRET}`
    });

    expect(await uploadImage(PHOTO)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the create path', () => {
  it('stores the hosted URL and no bytes when the upload succeeds', async () => {
    hosting();
    replyWith(200, { url: HOSTED });

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toBeUndefined();
    const { sql, params } = lastInsert();
    expect(sql).toContain('`url`');
    expect(sql).not.toContain('`data`');
    expect(params).toContain(HOSTED);
    expect(params).not.toContain(PHOTO);
    // The reply a client sees carries no secret.
    expect(JSON.stringify(reply)).not.toContain('sk_live');
  });

  it('falls back to the database when the host is down: the photo is never lost', async () => {
    hosting();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toBeUndefined();
    const { sql, params } = lastInsert();
    expect(sql).toContain('`data`');
    expect(params).toContain(PHOTO);
    expect(params).not.toContain(HOSTED);
    expect(logged()).toMatch(/stored in the database instead/);
  });

  it('falls back when the host answers a URL that fails the check', async () => {
    hosting();
    replyWith(200, { url: 'https://evil.test/beacon.gif' });

    await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    const { params } = lastInsert();
    expect(params).toContain(PHOTO);
    expect(params).not.toContain('https://evil.test/beacon.gif');
  });

  it('is byte for byte the old insert with no host configured', async () => {
    await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastInsert().params).toContain(PHOTO);
  });

  it('refuses an oversized payload before posting it anywhere', async () => {
    hosting();
    replyWith(200, { url: HOSTED });

    const reply = await call(CREATE_EVENT, {
      kind: 'photo',
      data: `data:image/webp;base64,${'A'.repeat(5 * 1024 * 1024)}`
    });

    expect(reply.error).toMatch(/too large/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  /**
   * The upload has to precede the insert (the quota is a predicate in it), so an insert that
   * refuses or throws after a successful upload leaves the file with no row naming it. It is
   * kept, as every hosted file is (MICA-428): the upload is the only request, a delete URL
   * configured or not.
   */
  const hostedWithDeleteUrl = () => {
    hosting({ mica_media_delete_url: 'https://api.example.test/files/{name}' });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ url: HOSTED }) });
  };

  it('keeps the uploaded file when the quota refuses the row', async () => {
    hostedWithDeleteUrl();
    dbMock.insert.mockResolvedValue(0);

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toMatch(/full/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as FetchCall)[1].method).toBe('POST');
  });

  it('keeps the uploaded file when the insert throws, and still reports the failure', async () => {
    hostedWithDeleteUrl();
    dbMock.insert.mockRejectedValue(new Error('deadlock'));

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as FetchCall)[1].method).toBe('POST');
  });

  it('asks the host for nothing when a refused row was never hosted', async () => {
    dbMock.insert.mockResolvedValue(0);

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toMatch(/full/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never lets a client set url itself', async () => {
    await call(CREATE_EVENT, { kind: 'photo', data: PHOTO, url: 'https://evil.test/x.png' });

    expect(lastInsert().params).not.toContain('https://evil.test/x.png');
  });
});
