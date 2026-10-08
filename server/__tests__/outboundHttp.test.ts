// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MICA-322: `micahttp`, the console's way to the Discord webhook and the catalog relay. Run
 * against the in-server suite's HTTPS sink under real Node `fetch` and real TLS, as
 * `integrationHttpSink.test.ts` runs the modules underneath, so what is asserted is what went
 * over the wire and what the console was told — never the webhook's token.
 */
const { dbMock, notifyPlayer } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
  notifyPlayer: vi.fn()
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: { getPlayer: () => null } }));
vi.mock('../lib/shell', () => ({ notifyPlayer }));

import { withSink, type HttpSink } from '../../integration/lib/httpSink';
import {
  __resetDiscordWebhook,
  forwardAudit,
  TEST_EMBED_TITLE,
  TEST_POST_CONTENT,
  WEBHOOK_CONVAR,
  webhookOrigin
} from '../lib/DiscordWebhook';
import { readCatalog, resetStoreCatalogForTests } from '../services/Store';
import { USAGE, WEBHOOK_TEST_TIMEOUT_MS, runOutboundHttpCommand } from '../services/OutboundHttp';

const TLS_CHECK = 'NODE_TLS_REJECT_UNAUTHORIZED';
const TOKEN = 'tOkEn-6f1d2c9a8b7e';

const convars = new Map<string, string>();
let tlsBefore: string | undefined;
let lines: string[] = [];

const run = (...args: string[]) => runOutboundHttpCommand(0, args);
const body = (sink: HttpSink, at = 0) =>
  sink.since(at).map((request) => JSON.parse(Buffer.from(request.body).toString('utf8')));

beforeEach(() => {
  tlsBefore = process.env[TLS_CHECK];
  delete process.env[TLS_CHECK];
  convars.clear();
  lines = [];
  (globalThis as any).GetConvar = (name: string, fallback: string) => convars.get(name) ?? fallback;
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(' '));
    });
  }
  notifyPlayer.mockReset();
  dbMock.query.mockReset().mockResolvedValue([]);
  resetStoreCatalogForTests();
  __resetDiscordWebhook();
});

afterEach(() => {
  __resetDiscordWebhook();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (tlsBefore === undefined) delete process.env[TLS_CHECK];
  else process.env[TLS_CHECK] = tlsBefore;
});

describe('who may run it', () => {
  it('refuses any source but the console, with a toast and no request', async () => {
    await withSink(async (sink) => {
      convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/${TOKEN}`);
      convars.set('mica_addon_catalog', `${sink.origin}/catalog.json`);
      convars.set('mica_addon_hosts', '127.0.0.1');
      sink.respond(() => ({ status: 204 }));

      await runOutboundHttpCommand(7, ['webhook']);
      await runOutboundHttpCommand(7, ['catalog']);
      expect(notifyPlayer).toHaveBeenCalledTimes(2);
      expect(notifyPlayer).toHaveBeenCalledWith(7, {
        type: 'error',
        message: 'You do not have permission to use that.',
        key: 'server.schema.noPermission'
      });
      expect(sink.since(0)).toEqual([]);
      expect(lines).toEqual([]);

      // The twin: the same sink, the same convars, from the console, is reached.
      await run('webhook');
      expect(sink.since(0)).toHaveLength(1);
    });
  });

  it('prints the usage for no subcommand, an unknown one, or a stray argument', async () => {
    for (const args of [[], ['ping'], ['webhook', 'extra']]) {
      lines = [];
      await runOutboundHttpCommand(0, args);
      expect(lines).toEqual(USAGE);
    }
  });
});

describe('micahttp webhook', () => {
  it('posts one labelled test embed to the webhook and names only its host', async () => {
    await withSink(async (sink) => {
      convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/${TOKEN}`);
      sink.respond(() => ({ status: 204 }));
      await run('webhook');

      const [post, ...rest] = sink.since(0);
      expect(rest).toEqual([]);
      expect(`${post.method} ${post.path}`).toBe(`POST /api/webhooks/1/${TOKEN}`);
      expect(post.headers['content-type']).toBe('application/json');
      const [sent] = body(sink);
      expect(sent.content).toBe(TEST_POST_CONTENT);
      expect(sent.embeds).toHaveLength(1);
      expect(sent.embeds[0].title).toBe(TEST_EMBED_TITLE);

      expect(lines).toEqual([
        `[micahttp] webhook: posted the embed "${TEST_EMBED_TITLE}" to ${sink.origin}/…; ` +
          'the host answered 204.'
      ]);
      // The token was in play — it is the path the sink saw — and no line carries it.
      expect(post.path).toContain(TOKEN);
      expect(lines.join('\n')).not.toContain(TOKEN);
    });
  });

  it('reports a 500 as refused, never throwing, and a later post still goes', async () => {
    await withSink(async (sink) => {
      convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/${TOKEN}`);
      sink.respond(() => ({ status: 500 }));
      await expect(run('webhook')).resolves.toBeUndefined();
      expect(sink.since(0)).toHaveLength(1);
      expect(lines).toEqual([
        `[micahttp] webhook: posted the embed "${TEST_EMBED_TITLE}" to ${sink.origin}/…; ` +
          'the host answered 500, so the post was refused.'
      ]);

      lines = [];
      sink.respond(() => ({ status: 204 }));
      await run('webhook');
      expect(sink.since(0)).toHaveLength(2);
      expect(lines[0]).toMatch(/the host answered 204\.$/);
      expect(lines.join('\n')).not.toContain(TOKEN);
    });
  });

  it('reports a hang-up as a failure, naming the host and not the token', async () => {
    await withSink(async (sink) => {
      convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/${TOKEN}`);
      sink.respond(() => ({ drop: true }));
      await run('webhook');
      expect(sink.since(0)).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        new RegExp(
          `^\\[micahttp\\] webhook: the post to ${sink.origin.replace(/\./g, '\\.')}/… failed: `
        )
      );
      expect(lines[0]).not.toContain(TOKEN);
    });
  });

  it('says the webhook is off when the convar is empty, and refuses a URL that is not https', async () => {
    await withSink(async (sink) => {
      sink.respond(() => ({ status: 204 }));
      await run('webhook');
      expect(lines).toEqual([
        '[micahttp] webhook: mica_discord_webhook is not set, so the webhook is off; nothing sent.'
      ]);

      lines = [];
      convars.set(
        WEBHOOK_CONVAR,
        `${sink.origin.replace('https:', 'http:')}/api/webhooks/1/${TOKEN}`
      );
      await run('webhook');
      expect(lines).toEqual([
        '[micahttp] webhook: mica_discord_webhook is set but is not an https:// URL, which ' +
          'micaOS never posts to; nothing sent.'
      ]);
      expect(sink.since(0)).toEqual([]);
    });
  });

  it('gives up waiting after its timeout, saying so', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    convars.set(WEBHOOK_CONVAR, `https://discord.example/api/webhooks/1/${TOKEN}`);
    const done = run('webhook');
    await vi.advanceTimersByTimeAsync(WEBHOOK_TEST_TIMEOUT_MS);
    await done;
    expect(lines).toEqual([
      `[micahttp] webhook: no answer within ${WEBHOOK_TEST_TIMEOUT_MS / 1000} s; the post may still land.`
    ]);
  });
});

describe('a webhook that redirects (MICA-322)', () => {
  const STOLEN = '/stolen';
  const redirecting = (sink: HttpSink, status: number) =>
    sink.respond((request) =>
      request.path === STOLEN
        ? { status: 204 }
        : { status, headers: { Location: `${sink.origin}${STOLEN}` } }
    );

  it.each([307, 308, 302])(
    'is refused by the test post on a %i, and the target is never asked',
    async (status) => {
      await withSink(async (sink) => {
        convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/${TOKEN}`);
        redirecting(sink, status);
        await run('webhook');
        // The twin: the webhook itself was asked, so the redirect was there to follow.
        expect(sink.since(0).map((request) => `${request.method} ${request.path}`)).toEqual([
          `POST /api/webhooks/1/${TOKEN}`
        ]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[micahttp\] webhook: the post to .* failed: .*redirect/);
        expect(lines[0]).not.toContain(TOKEN);
      });
    }
  );

  it('is refused by the audit queue too, logged as a failed post', async () => {
    await withSink(async (sink) => {
      convars.set(WEBHOOK_CONVAR, `${sink.origin}/api/webhooks/1/${TOKEN}`);
      redirecting(sink, 307);
      forwardAudit({
        citizenid: 'ADMIN_1',
        action: 'moderated',
        service: 'reports',
        method: 'resolve',
        targetId: 42,
        targetTable: 'mica_media'
      });
      await sink.waitFor(0, () => true, 5_000, { aborted: false }, 'the queued post');
      await vi.waitFor(() => expect(lines.some((line) => line.includes('redirect'))).toBe(true));
      expect(sink.since(0).map((request) => request.path)).toEqual([`/api/webhooks/1/${TOKEN}`]);
    });
  });
});

describe('webhookOrigin', () => {
  it('keeps scheme and host, and drops the path, the query and any userinfo', () => {
    expect(webhookOrigin(`https://discord.com/api/webhooks/1/${TOKEN}`)).toBe(
      'https://discord.com/…'
    );
    expect(webhookOrigin(`https://user:${TOKEN}@hooks.example:8443/x?t=${TOKEN}`)).toBe(
      'https://hooks.example:8443/…'
    );
    expect(webhookOrigin(`https://hooks.example?t=${TOKEN}`)).toBe('https://hooks.example/…');
  });
});

describe('micahttp catalog', () => {
  const point = (sink: HttpSink, path: string) => {
    convars.set('mica_addon_catalog', `${sink.origin}${path}`);
    convars.set('mica_addon_hosts', '127.0.0.1');
  };

  it('fetches past the cache every time, and refills the copy phones get', async () => {
    await withSink(async (sink) => {
      point(sink, '/addons/catalog.json');
      sink.respond(() => ({ status: 200, json: [{ id: 'weather' }, { id: 'radio' }, {}] }));

      await run('catalog');
      const [request] = sink.since(0);
      expect(`${request.method} ${request.path}`).toBe('GET /addons/catalog.json');
      expect(request.headers.accept).toBe('application/json');
      expect(lines).toEqual([
        `[micahttp] catalog: fetched ${sink.origin}/addons/catalog.json (custom): 3 entries ` +
          '(weather, radio). Phones get this copy for the next 10 minutes.'
      ]);

      // A phone's ask is answered from what the command fetched; a second command refetches.
      expect(await readCatalog()).toEqual({
        status: 'ok',
        entries: [{ id: 'weather' }, { id: 'radio' }, {}]
      });
      expect(sink.since(0)).toHaveLength(1);
      await run('catalog');
      expect(sink.since(0)).toHaveLength(2);
    });
  });

  it('reports a 500 as unavailable, never throwing, and phones are held off', async () => {
    await withSink(async (sink) => {
      point(sink, '/failing.json');
      sink.respond(() => ({ status: 500 }));
      await expect(run('catalog')).resolves.toBeUndefined();
      expect(sink.since(0)).toHaveLength(1);
      expect(lines).toContain(
        `[micahttp] catalog: ${sink.origin}/failing.json (custom) is unavailable: the host ` +
          'answered 500. Phones are told so for the next 1 minute.'
      );
      expect(await readCatalog()).toEqual({ status: 'unavailable' });
      expect(sink.since(0)).toHaveLength(1);
    });
  });

  it('refuses a redirect without following it', async () => {
    await withSink(async (sink) => {
      point(sink, '/moved.json');
      sink.respond((request) =>
        request.path === '/moved.json'
          ? { status: 302, headers: { Location: `${sink.origin}/elsewhere.json` } }
          : { status: 200, json: [] }
      );
      await run('catalog');
      expect(sink.since(0).map((request) => request.path)).toEqual(['/moved.json']);
      expect(lines.some((line) => /^\[micahttp\] catalog: .* is unavailable: /.test(line))).toBe(
        true
      );
    });
  });

  it('refuses a host the allowlist does not name, without a request', async () => {
    await withSink(async (sink) => {
      sink.respond(() => ({ status: 200, json: [] }));
      convars.set('mica_addon_catalog', `${sink.origin}/catalog.json`);
      convars.set('mica_addon_hosts', 'mica.gg');
      await run('catalog');
      expect(lines).toEqual([
        `[micahttp] catalog: ${sink.origin}/catalog.json (custom) was not fetched: its host ` +
          "'127.0.0.1' is not in mica_addon_hosts."
      ]);
      expect(sink.since(0)).toEqual([]);

      // The twin: allowed, the same URL is fetched.
      lines = [];
      convars.set('mica_addon_hosts', '127.0.0.1');
      await run('catalog');
      expect(sink.since(0)).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[micahttp\] catalog: fetched /);
    });
  });

  it('redacts a token in the catalog URL from every line', async () => {
    await withSink(async (sink) => {
      convars.set('mica_addon_catalog', `${sink.origin}/catalog.json?key=${TOKEN}`);
      convars.set('mica_addon_hosts', '127.0.0.1');
      sink.respond(() => ({ status: 500 }));
      await run('catalog');
      expect(sink.since(0)[0].path).toBe(`/catalog.json?key=${TOKEN}`);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toContain(TOKEN);
    });
  });

  it('says the catalog is off, and fetches nothing', async () => {
    convars.set('mica_addon_catalog', 'off');
    await run('catalog');
    expect(lines).toEqual([
      '[micahttp] catalog: mica_addon_catalog is off, so the Store lists no remote add-ons; ' +
        'nothing fetched.'
    ]);
  });
});
