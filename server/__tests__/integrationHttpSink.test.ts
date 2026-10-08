// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The in-server suite's HTTP sink (MICA-304, `integration/lib/httpSink.ts`), run here under
 * real Node `fetch` and real TLS — and micaOS's three outbound HTTP modules run against it.
 *
 * Two jobs. The first is the sink's own: the hand-written certificate has to be one Node's TLS
 * accepts, the multipart reader has to read what Node's `FormData` actually writes, and a sink
 * nobody can reach has to fail loudly. Getting any of that wrong would surface on hoth as a
 * scenario failing for the harness's reasons, not micaOS's.
 *
 * The second is the modules' requests on the wire: method, path, headers and body as Node's
 * own `fetch` sends them, which the stubbed-fetch suites (`discordWebhook.test.ts`,
 * `store.test.ts`) cannot show, reached here through the entry points a player's net event
 * calls — `forwardAudit` for the Discord webhook (MICA-242), `catalogEntries` for the catalog
 * relay (MICA-237). What this cannot show is FXServer's runtime. `integration/scenarios/http.ts`
 * shows that for all three: the image host through its own paths, and the other two through
 * `micahttp` (MICA-322), the console command that drives the same requests with no player
 * connected. `outboundHttp.test.ts` runs that command against this sink.
 *
 * `Database` is mocked as every server suite mocks it; the image host's reference check and its
 * ledger write are the only queries reached, and both are answered empty.
 */
const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: { getPlayer: () => null }
}));

import {
  parseMultipart,
  startSink,
  trustAnyCertificate,
  withSink,
  type HttpSink
} from '../../integration/lib/httpSink';
import { selfSignedIdentity } from '../../integration/lib/selfSigned';
import { releaseHostedImages, resetMediaHostForTests, uploadImage } from '../lib/mediaHost';
import { __resetDiscordWebhook, forwardAudit, WEBHOOK_CONVAR } from '../lib/DiscordWebhook';
import { catalogEntries, resetStoreCatalogForTests } from '../services/Store';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_BASE64, 'base64');
const TLS_CHECK = 'NODE_TLS_REJECT_UNAUTHORIZED';
const never = { aborted: false };

const convars = new Map<string, string>();
let tlsBefore: string | undefined;

beforeEach(() => {
  tlsBefore = process.env[TLS_CHECK];
  delete process.env[TLS_CHECK];
  convars.clear();
  (globalThis as any).GetConvar = (name: string, fallback: string) => convars.get(name) ?? fallback;
  dbMock.query.mockReset().mockResolvedValue([]);
  resetMediaHostForTests();
  resetStoreCatalogForTests();
  __resetDiscordWebhook();
});

afterEach(() => {
  __resetDiscordWebhook();
  vi.restoreAllMocks();
  if (tlsBefore === undefined) delete process.env[TLS_CHECK];
  else process.env[TLS_CHECK] = tlsBefore;
});

describe('the certificate', () => {
  it('is a self-signed X.509 for 127.0.0.1 and localhost that Node parses and verifies', () => {
    const identity = selfSignedIdentity(new Date('2026-10-06T12:00:00Z'));
    const cert = new X509Certificate(identity.cert);
    expect(cert.verify(createPublicKey(createPrivateKey(identity.key)))).toBe(true);
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(cert.checkHost('localhost')).toBe('localhost');
    expect(cert.subject).toBe('CN=mica-integration sink');
    expect(new Date(cert.validFrom).getTime()).toBe(Date.parse('2026-10-06T11:00:00Z'));
    expect(new Date(cert.validTo).getTime()).toBe(Date.parse('2026-10-07T12:00:00Z'));
  });

  it('is a fresh key every time', () => {
    expect(selfSignedIdentity().key).not.toBe(selfSignedIdentity().key);
  });
});

describe('parseMultipart', () => {
  it("reads exactly what Node's FormData writes", async () => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'mica-1.png');
    form.append('note', 'hello');
    const request = new Request('https://sink.invalid/', { method: 'POST', body: form });
    const body = Buffer.from(await request.arrayBuffer());

    const parts = parseMultipart(request.headers.get('content-type') ?? undefined, body);
    expect(
      parts.map(({ name, filename, contentType }) => ({ name, filename, contentType }))
    ).toEqual([
      { name: 'file', filename: 'mica-1.png', contentType: 'image/png' },
      { name: 'note', filename: null, contentType: null }
    ]);
    expect(Buffer.from(parts[0].data).equals(PNG)).toBe(true);
    expect(Buffer.from(parts[1].data).toString('utf8')).toBe('hello');
  });

  it('refuses a body that is not multipart, or one that is never closed', () => {
    expect(() => parseMultipart('application/json', Buffer.from('{}'))).toThrow(/not multipart/);
    const open = Buffer.from(
      '--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nbytes with no end',
      'utf8'
    );
    expect(() => parseMultipart('multipart/form-data; boundary=b', open)).toThrow(/never closed/);
  });
});

describe('the sink', () => {
  it('records what arrives and answers as it is told, under real TLS', async () => {
    await withSink(async (sink) => {
      sink.respond((request) =>
        request.path === '/fail' ? { status: 500, json: { error: 'down' } } : { status: 201 }
      );
      const from = sink.mark();
      const ok = await fetch(`${sink.origin}/ok?x=1`, {
        method: 'PUT',
        headers: { 'X-Thing': 'a' },
        body: 'payload'
      });
      const failed = await fetch(`${sink.origin}/fail`, { method: 'POST' });
      expect([ok.status, failed.status]).toEqual([201, 500]);
      expect(await failed.json()).toEqual({ error: 'down' });

      const seen = sink.since(from);
      expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['PUT /ok?x=1', 'POST /fail']);
      expect(seen[0].headers['x-thing']).toBe('a');
      expect(Buffer.from(seen[0].body).toString('utf8')).toBe('payload');
    });
    // Put back as it was: unset.
    expect(process.env[TLS_CHECK]).toBeUndefined();
  });

  it('hangs up without answering when told to, which fetch sees as a failure', async () => {
    await withSink(async (sink) => {
      sink.respond(() => ({ drop: true }));
      await expect(fetch(`${sink.origin}/gone`)).rejects.toThrow();
      expect(sink.since(0).map((r) => r.path)).toEqual(['/gone']);
    });
  });

  it('does not record its own probe', async () => {
    await withSink(async (sink) => {
      await sink.probe();
      expect(sink.since(0)).toEqual([]);
    });
  });

  it('fails the probe, loudly, when the certificate is not trusted', async () => {
    const sink = await startSink();
    try {
      await expect(sink.probe()).rejects.toThrow(/own fetch cannot reach it/);
    } finally {
      await sink.close();
    }
  });

  it('puts the TLS check back even when the run throws', async () => {
    process.env[TLS_CHECK] = '1';
    await expect(
      withSink(async () => {
        expect(process.env[TLS_CHECK]).toBe('0');
        throw new Error('the scenario failed');
      })
    ).rejects.toThrow('the scenario failed');
    expect(process.env[TLS_CHECK]).toBe('1');
    const restore = trustAnyCertificate();
    restore();
    expect(process.env[TLS_CHECK]).toBe('1');
  });

  it('times out naming what did arrive', async () => {
    await withSink(async (sink) => {
      sink.respond(() => ({ status: 204 }));
      await fetch(`${sink.origin}/other`);
      await expect(
        sink.waitFor(0, (r) => r.path === '/wanted', 200, never, 'the wanted request')
      ).rejects.toThrow(
        /no the wanted request reached the sink within 200 ms; it received: GET \/other/
      );
    });
  });
});

/** Point the image host's convars at `sink`, as `integration/scenarios/http.ts` does. */
const imageHostAt = (sink: HttpSink, secret: string): void => {
  convars.set('mica_media_upload_url', `${sink.origin}/itx/upload`);
  convars.set('mica_media_upload_header', `X-Itx-Key: ${secret}`);
  convars.set('mica_media_delete_url', `${sink.origin}/itx/delete/{name}`);
};

describe('the image host (MICA-243, MICA-292), on the wire', () => {
  it('uploads the photo as multipart with the header, and stores the URL the host answers', async () => {
    await withSink(async (sink) => {
      imageHostAt(sink, 'k-123');
      sink.respond(() => ({ status: 200, json: { url: 'https://127.0.0.1/itx/files/a.png' } }));

      const hosted = await uploadImage(`data:image/png;base64,${PNG_BASE64}`);
      expect(hosted).toEqual({
        url: 'https://127.0.0.1/itx/files/a.png',
        mimeType: 'image/png',
        bytes: PNG.length
      });

      const [upload, ...rest] = sink.since(0);
      expect(rest).toEqual([]);
      expect(`${upload.method} ${upload.path}`).toBe('POST /itx/upload');
      expect(upload.headers['x-itx-key']).toBe('k-123');
      const parts = parseMultipart(upload.headers['content-type'], upload.body);
      expect(parts).toHaveLength(1);
      expect(parts[0].name).toBe('file');
      expect(parts[0].filename).toMatch(/^mica-\d+\.png$/);
      expect(parts[0].contentType).toBe('image/png');
      expect(Buffer.from(parts[0].data).equals(PNG)).toBe(true);
    });
  });

  it('falls back to the database on a 500, saying why and never the header', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withSink(async (sink) => {
      imageHostAt(sink, 'k-secret-456');
      sink.respond(() => ({ status: 500 }));
      expect(await uploadImage(`data:image/png;base64,${PNG_BASE64}`)).toBeNull();
      expect(sink.since(0)).toHaveLength(1);
    });
    const said = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(said).toContain(
      '[micamedia] upload to 127.0.0.1 failed (the host answered 500); the photo was stored in the database instead.'
    );
    expect(said).not.toContain('k-secret-456');
  });

  it('refuses a redirect rather than carrying the header to it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withSink(async (sink) => {
      imageHostAt(sink, 'k-789');
      sink.respond((request) =>
        request.path === '/itx/upload'
          ? { status: 307, headers: { Location: `${sink.origin}/itx/stolen` } }
          : { status: 200, json: { url: 'https://127.0.0.1/itx/files/s.png' } }
      );
      expect(await uploadImage(`data:image/png;base64,${PNG_BASE64}`)).toBeNull();
      expect(sink.since(0).map((r) => r.path)).toEqual(['/itx/upload']);
    });
  });

  it('asks the host to DELETE each unreferenced file by name, with the header', async () => {
    await withSink(async (sink) => {
      imageHostAt(sink, 'k-del');
      sink.respond((request) =>
        request.path.endsWith('/b.png') ? { status: 404 } : { status: 500 }
      );
      const outcome = await releaseHostedImages([
        'https://127.0.0.1/itx/files/a.png',
        'https://127.0.0.1/itx/files/b.png'
      ]);
      // 404 is "already gone", which is what was asked for; the 500 is left on the host.
      expect(outcome).toMatchObject({ deleted: 1, failed: 1, unconfigured: 0 });
      const seen = sink.since(0);
      expect(seen.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
        'DELETE /itx/delete/a.png',
        'DELETE /itx/delete/b.png'
      ]);
      expect(seen.every((r) => r.headers['x-itx-key'] === 'k-del')).toBe(true);
    });
  });
});

describe('the Discord webhook (MICA-242), on the wire', () => {
  const moderation = {
    citizenid: 'ADMIN_1',
    action: 'moderated',
    service: 'reports',
    method: 'resolve',
    targetId: 42,
    targetTable: 'mica_media',
    details: 'harassment'
  } as const;

  it('POSTs a JSON embed to the configured URL, without the details by default', async () => {
    await withSink(async (sink) => {
      convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/abc`);
      sink.respond(() => ({ status: 204 }));
      forwardAudit(moderation);

      const post = await sink.waitFor(0, () => true, 5_000, never, 'the webhook post');
      expect(`${post.method} ${post.path}`).toBe('POST /api/webhooks/1/abc');
      expect(post.headers['content-type']).toBe('application/json');
      const body = JSON.parse(Buffer.from(post.body).toString('utf8'));
      expect(body.content).toBeUndefined();
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0]).toMatchObject({
        title: 'Moderation',
        fields: [
          { name: 'Action', value: 'moderated · reports.resolve', inline: true },
          { name: 'Actor', value: 'ADMIN_1', inline: true },
          { name: 'Target', value: 'mica_media #42', inline: true }
        ]
      });
      expect(JSON.stringify(body)).not.toContain('harassment');
    });
  });

  it('logs a refused post once and carries on, and never throws to the caller', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withSink(async (sink) => {
      convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/abc`);
      sink.respond(() => ({ status: 500 }));
      expect(() => forwardAudit(moderation)).not.toThrow();
      await sink.waitFor(0, () => true, 5_000, never, 'the first post');
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

      // The second refusal reaches the sink, and the console hears nothing more.
      const second = sink.mark();
      forwardAudit({ ...moderation, targetId: 43 });
      await sink.waitFor(second, () => true, 5_000, never, 'the second post');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('Discord answered 500');
    });
  });
});

describe('the add-on catalog relay (MICA-237), on the wire', () => {
  it('GETs the catalog with Accept: application/json and relays the array', async () => {
    await withSink(async (sink) => {
      sink.respond(() => ({ status: 200, json: [{ id: 'weather' }] }));
      const url = `${sink.origin}/addons/catalog.json`;
      expect(await catalogEntries(url, ['127.0.0.1'])).toEqual([{ id: 'weather' }]);
      const [request, ...rest] = sink.since(0);
      expect(rest).toEqual([]);
      expect(`${request.method} ${request.path}`).toBe('GET /addons/catalog.json');
      expect(request.headers.accept).toBe('application/json');
      // Cached: a second ask does not reach the host.
      expect(await catalogEntries(url, ['127.0.0.1'])).toEqual([{ id: 'weather' }]);
      expect(sink.since(0)).toHaveLength(1);
    });
  });

  it('answers unavailable on a 500 or a redirect, and never follows the redirect', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withSink(async (sink) => {
      sink.respond((request) =>
        request.path === '/failing.json'
          ? { status: 500 }
          : request.path === '/moved.json'
            ? { status: 302, headers: { Location: `${sink.origin}/elsewhere.json` } }
            : { status: 200, json: [] }
      );
      expect(await catalogEntries(`${sink.origin}/failing.json`, ['127.0.0.1'])).toBeNull();
      expect(await catalogEntries(`${sink.origin}/moved.json`, ['127.0.0.1'])).toBeNull();
      expect(sink.since(0).map((r) => r.path)).toEqual(['/failing.json', '/moved.json']);
    });
  });
});
