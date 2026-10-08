// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { Scenario } from '../runner';
import { requireTap, type ConsoleTap } from '../lib/console';
import { db } from '../lib/db';
import {
  parseMultipart,
  withSink,
  type HttpSink,
  type Responder,
  type SinkReply,
  type SinkRequest
} from '../lib/httpSink';
import { assert, expectOk, runCommand, seedCitizen, unique } from '../lib/mica';
import { QBX_SEED } from '../lib/qbxSeed';
import { bootOrphanSweepEnded } from '../lib/bootSweep';
import { runMediaPrune } from '../lib/mediaPrune';
import { eventually } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * What micaOS sends over HTTP, received by a stub HTTPS server inside this resource
 * (`lib/httpSink.ts`, MICA-304) and checked request by request.
 *
 * All three of micaOS's outbound callers are here. The image host (MICA-243, MICA-292) is the one
 * a server reaches with no player connected: `AddMedia` uploads, and the purge, the media-only
 * purge and the orphan sweep release. The other two answer only a player's net event in play —
 * the Discord webhook (MICA-242) mirrors audit entries a player's action writes, and the add-on
 * catalog relay (MICA-237) answers `store:catalog` — so they are driven here through
 * `micahttp` (MICA-322), the console command that sends one through the same request and
 * checks. What that does not prove is the net-event half in front of each: that a moderation
 * reaches `forwardAudit`, that a phone's `store:catalog` reaches `readCatalog`. Those still wait
 * for a harness that can connect a client.
 *
 * Every URL micaOS posts to is a convar it reads on each call, so each scenario points micaOS at
 * its own sink with `SetConvar` and puts every convar back as it was afterwards. Nothing in the
 * wrapper's server.cfg changes for it.
 */

const HOST = '127.0.0.1';
const UPLOAD_PATH = '/itx/upload';
const DELETE_PREFIX = '/itx/delete/';
/** Where a redirect from the upload points. Never requested, if micaOS refuses redirects. */
const STOLEN_PATH = '/itx/stolen';
/**
 * Where the host says the files are: on the image host's default port, as micaOS requires of a
 * hosted URL. Nothing is served there and nothing needs to be: micaOS stores the URL, and the
 * phone, which would draw it, is not here.
 */
const FILES = `https://${HOST}/itx/files/`;
const KEY_HEADER = 'X-Itx-Key';

/** A 1×1 PNG: an image data URI is what `AddMedia` hands the host. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;
const PNG = Buffer.from(PNG_BASE64, 'base64');
const PHOTO = { kind: 'photo', data: PNG_DATA_URI };

/** Every convar `server/lib/mediaHost.ts` reads, set for a scenario and put back afterwards. */
const MEDIA_CONVARS = [
  'mica_media_upload_url',
  'mica_media_upload_header',
  'mica_media_upload_field',
  'mica_media_upload_response_path',
  'mica_media_image_host',
  'mica_media_delete_url'
] as const;

interface ImageHost {
  sink: HttpSink;
  /** The upload header's value: the API key an owner would configure. */
  secret: string;
  /** How the next uploads are answered; null for the default, a fresh file name each. */
  onUpload(reply: Responder | null): void;
  /** How a delete for one file name is answered. 204 by default. */
  onDelete(reply: (name: string) => SinkReply): void;
}

const fileName = (): string => `itx-${randomBytes(6).toString('hex')}.png`;

/**
 * A sink standing in for an owner's image host, and micaOS pointed at it: uploads to
 * `UPLOAD_PATH` with `KEY_HEADER`, deletes at `DELETE_PREFIX{name}`. The field name, the reply
 * path and the image host are left unset, so what is proven is micaOS's defaults for them —
 * `file`, `url`, and the upload URL's own host.
 */
const withImageHost = (run: (host: ImageHost) => Promise<void>): Promise<void> =>
  withSink(async (sink) => {
    const secret = randomBytes(16).toString('hex');
    const issue: Responder = () => ({ status: 200, json: { url: `${FILES}${fileName()}` } });
    let upload = issue;
    let remove: (name: string) => SinkReply = () => ({ status: 204 });
    sink.respond((request) => {
      if (request.method === 'POST' && request.path === UPLOAD_PATH) return upload(request);
      if (request.method === 'DELETE' && request.path.startsWith(DELETE_PREFIX)) {
        return remove(decodeURIComponent(request.path.slice(DELETE_PREFIX.length)));
      }
      return { status: 404 };
    });

    const previous = MEDIA_CONVARS.map((name) => [name, GetConvar(name, '')] as const);
    SetConvar('mica_media_upload_url', `${sink.origin}${UPLOAD_PATH}`);
    SetConvar('mica_media_upload_header', `${KEY_HEADER}: ${secret}`);
    SetConvar('mica_media_upload_field', '');
    SetConvar('mica_media_upload_response_path', '');
    SetConvar('mica_media_image_host', '');
    SetConvar('mica_media_delete_url', `${sink.origin}${DELETE_PREFIX}{name}`);
    try {
      await run({
        sink,
        secret,
        onUpload: (reply) => {
          upload = reply ?? issue;
        },
        onDelete: (reply) => {
          remove = reply;
        }
      });
    } finally {
      for (const [name, value] of previous) SetConvar(name, value);
    }
  });

const describe = (requests: readonly SinkRequest[]): string =>
  requests.length === 0
    ? 'nothing'
    : requests.map((request) => `${request.method} ${request.path}`).join(', ');

/** What micaOS's media code said since `mark`: the diagnosis when a request never came. */
const mediaSaid = (tap: ConsoleTap, mark: number): string => {
  const lines = tap
    .since(mark)
    .filter((line) => /^\s*\[(micamedia|mica)\]/.test(line))
    .slice(-4);
  return lines.length > 0 ? lines.join(' | ') : 'nothing';
};

/** The API key never reaches the console, whatever the host did. */
const assertNoLeak = (tap: ConsoleTap, mark: number, secret: string): void => {
  const leaked = tap.since(mark).filter((line) => line.includes(secret)).length;
  assert(leaked === 0, `the upload header's value appeared in ${leaked} console line(s)`);
};

/** One upload, as `mediaHost.uploadImage` promises to send it. */
const assertUpload = (request: SinkRequest, secret: string): void => {
  assert(
    request.method === 'POST' && request.path === UPLOAD_PATH,
    `the upload was ${request.method} ${request.path}, not POST ${UPLOAD_PATH}`
  );
  assert(
    request.headers[KEY_HEADER.toLowerCase()] === secret,
    `the upload did not carry ${KEY_HEADER} with the configured value`
  );
  assert(!request.truncated, 'the upload was larger than the sink keeps');
  const parts = parseMultipart(request.headers['content-type'], request.body);
  assert(
    parts.length === 1,
    `the upload held ${parts.length} part(s): ${parts.map((p) => p.name).join(', ')}`
  );
  const [part] = parts;
  assert(part.name === 'file', `the photo travelled in field '${part.name}', not 'file'`);
  assert(
    /^mica-\d+\.png$/.test(part.filename ?? ''),
    `the photo's file name is '${String(part.filename)}', not mica-<time>.png`
  );
  assert(part.contentType === 'image/png', `the photo's part is typed ${String(part.contentType)}`);
  assert(
    part.data.equals(PNG),
    `the uploaded file is ${part.data.length} bytes and not the photo's ${PNG.length}`
  );
};

const mediaRow = (id: number) =>
  db.row('SELECT `url`, `data`, `mime_type`, `byte_size` FROM `mica_media` WHERE `id` = ?', [id]);

const exists = async (id: number): Promise<boolean> =>
  (await db.count('SELECT COUNT(*) FROM `mica_media` WHERE `id` = ?', [id])) === 1;

/** The hosted file a row names, by its last path segment, which is what a delete asks for. */
const hostedName = async (id: number): Promise<string> => {
  const url = String((await mediaRow(id))?.url ?? '');
  assert(url.startsWith(FILES), `media ${id} names '${url}', not a file on the sink`);
  return url.slice(FILES.length);
};

const deletedNames = (requests: readonly SinkRequest[]): string[] =>
  requests
    .filter((request) => request.method === 'DELETE' && request.path.startsWith(DELETE_PREFIX))
    .map((request) => decodeURIComponent(request.path.slice(DELETE_PREFIX.length)));

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── micahttp (MICA-322) ─────────────────────────────────────────────────────────────────────

/**
 * What `GetConvar` hands back for a convar nobody set, and what restores "nobody set it": the
 * Store tells unset from empty by this exact default (`CONVAR_UNSET`, `shared/addonConfig.ts`,
 * which this resource cannot import), and an unset catalog is the public one where an empty one
 * is off. Putting back `''` would turn a stock server's catalog off for every later scenario.
 */
const CONVAR_UNSET = '__mica_convar_unset__';

/** The test post's plain-text line and embed title, as `DiscordWebhook.ts` writes them. */
const TEST_POST_CONTENT = 'micaOS webhook test: not a moderation event.';
const TEST_EMBED_TITLE = 'micaOS webhook test';

const WEBHOOK_PREFIX = '/api/webhooks/';

interface Webhook {
  sink: HttpSink;
  /** The token in the webhook's path, which no console line may carry. */
  token: string;
  path: string;
}

/**
 * A sink standing in for Discord, and `mica_discord_webhook` pointed at it with a fresh token,
 * shaped as Discord's are: `/api/webhooks/<id>/<token>`. Put back as it was afterwards.
 */
const withWebhook = (run: (hook: Webhook) => Promise<void>): Promise<void> =>
  withSink(async (sink) => {
    const token = randomBytes(24).toString('hex');
    const path = `${WEBHOOK_PREFIX}${Date.now()}/${token}`;
    sink.respond(() => ({ status: 204 }));
    const previous = GetConvar('mica_discord_webhook', '');
    SetConvar('mica_discord_webhook', `${sink.origin}${path}`);
    try {
      await run({ sink, token, path });
    } finally {
      SetConvar('mica_discord_webhook', previous);
    }
  });

/** The two catalog convars pointed at `url`, allowing only the sink's host, for `run`. */
const withCatalog = async (url: string, run: () => Promise<void>): Promise<void> => {
  const previous = (['mica_addon_catalog', 'mica_addon_hosts'] as const).map(
    (name) => [name, GetConvar(name, CONVAR_UNSET)] as const
  );
  SetConvar('mica_addon_catalog', url);
  SetConvar('mica_addon_hosts', HOST);
  try {
    await run();
  } finally {
    for (const [name, value] of previous) SetConvar(name, value);
  }
};

const micahttpSaid = (tap: ConsoleTap, mark: number): string => {
  const lines = tap
    .since(mark)
    .filter((line) => /^\s*\[(micahttp|micaOS|DiscordWebhook)\]/.test(line))
    .slice(-4);
  return lines.length > 0 ? lines.join(' | ') : 'nothing';
};

/** A line that says a script threw rather than answered. */
const THREW = /SCRIPT ERROR|unhandled/i;

const assertNoToken = (tap: ConsoleTap, mark: number, token: string): void => {
  const leaked = tap.since(mark).filter((line) => line.includes(token)).length;
  assert(leaked === 0, `the webhook's token appeared in ${leaked} console line(s)`);
};

const jsonOf = (request: SinkRequest): { content?: unknown; embeds?: { title?: unknown }[] } => {
  try {
    return JSON.parse(Buffer.from(request.body).toString('utf8'));
  } catch {
    throw new Error(`the webhook post's body is not JSON: ${request.headers['content-type']}`);
  }
};

const ORIGIN = `https://${literal(HOST)}:\\d+`;
/**
 * The `…` micaOS puts where the webhook's path was. Matched as up to three characters with no
 * slash, since nothing yet proves FXServer's console hands UTF-8 through intact; a path, which
 * is what must not be there, is longer and has slashes. `assertNoToken` is the leak check.
 */
const ELLIPSIS = '[^/\\s;]{1,3}';

const UPLOAD_FAILED =
  /^\[micamedia\] upload to 127\.0\.0\.1 failed \((.*)\); the photo was stored in the database instead\.$/;

export const httpScenarios: Scenario[] = [
  {
    // MICA-243: with an image host configured, a photo's bytes go to it — POST, the owner's
    // header, multipart with the file in `file` — and the row keeps only the URL it answered.
    // MICA-293: the row records the size the host was sent. MICA-292: the host is recorded.
    id: 'http-media-upload-posts-the-photo-to-the-image-host',
    mode: 'standalone',
    tickets: ['MICA-243', 'MICA-292', 'MICA-293', 'MICA-304'],
    run: (signal) =>
      withImageHost(async (host) => {
        const tap = requireTap();
        const who = await seedCitizen('http_upload');
        const mark = tap.mark();
        const from = host.sink.mark();

        const { id } = await expectOk<{ id: number }>('AddMedia', who.citizenid, PHOTO);

        const received = host.sink.since(from);
        assert(
          received.length === 1,
          `the image host received ${describe(received)} for one photo; micaOS said: ` +
            mediaSaid(tap, mark)
        );
        assertUpload(received[0], host.secret);

        const row = await mediaRow(id);
        assert(row !== null, `AddMedia answered id ${id}, and no such row exists`);
        const name = await hostedName(id);
        assert(/^itx-[0-9a-f]{12}\.png$/.test(name), `the row names '${name}', not a sink file`);
        assert(
          row?.data === null || row?.data === '',
          "the row kept the photo's bytes although the host took them"
        );
        assert(row?.mime_type === 'image/png', `the row's mime_type is ${String(row?.mime_type)}`);
        assert(
          Number(row?.byte_size) === PNG.length,
          `the row's byte_size is ${String(row?.byte_size)}, not the ${PNG.length} bytes sent`
        );
        await eventually(
          async () =>
            (await db.count('SELECT COUNT(*) FROM `mica_schema_migrations` WHERE `id` = ?', [
              `mediahost:${HOST}`
            ])) || null,
          5_000,
          signal,
          'the image host recorded in mica_schema_migrations'
        );

        const failed = tap.since(mark).filter((line) => UPLOAD_FAILED.test(line));
        assert(failed.length === 0, `micaOS reported a failed upload: ${failed.join(' | ')}`);
        assertNoLeak(tap, mark, host.secret);
      })
  },
  {
    // MICA-243: a host that refuses, hangs up or redirects never costs the photo. The write
    // answers ok, the bytes are in the row, the console says why, and the redirect's target
    // never sees the API key.
    id: 'http-media-upload-refused-keeps-the-photo-in-the-database',
    mode: 'standalone',
    tickets: ['MICA-243', 'MICA-304'],
    run: (signal) =>
      withImageHost(async (host) => {
        const tap = requireTap();
        const who = await seedCitizen('http_upload_refused');
        const cases: { what: string; reply: Responder; reason?: RegExp }[] = [
          {
            what: 'answers 500',
            reply: () => ({ status: 500, json: { error: 'down' } }),
            reason: /^the host answered 500$/
          },
          { what: 'hangs up without answering', reply: () => ({ drop: true }) },
          {
            what: 'redirects elsewhere',
            reply: () => ({
              status: 307,
              headers: { Location: `${host.sink.origin}${STOLEN_PATH}` }
            })
          }
        ];

        for (const each of cases) {
          host.onUpload(each.reply);
          const mark = tap.mark();
          const from = host.sink.mark();

          const { id } = await expectOk<{ id: number }>('AddMedia', who.citizenid, PHOTO);

          // The twin of every claim below: the host was asked, so what it answered was heard.
          const posts = host.sink
            .since(from)
            .filter((request) => request.method === 'POST' && request.path === UPLOAD_PATH);
          assert(
            posts.length === 1,
            `a host that ${each.what} received ${posts.length} upload(s), not 1; micaOS said: ` +
              mediaSaid(tap, mark)
          );
          assertUpload(posts[0], host.secret);

          const row = await mediaRow(id);
          assert(
            row?.data === PNG_DATA_URI,
            `with a host that ${each.what}, the row does not hold the photo's bytes`
          );
          assert(
            row?.url === null || row?.url === '',
            `with a host that ${each.what}, the row names ${String(row?.url)}`
          );
          const said = await tap.waitFor(
            mark,
            UPLOAD_FAILED,
            5_000,
            signal,
            `micaOS's line for a host that ${each.what}`
          );
          const why = UPLOAD_FAILED.exec(said)?.[1] ?? '';
          assert(!each.reason || each.reason.test(why), `micaOS gave the reason '${why}'`);
          assertNoLeak(tap, mark, host.secret);
        }

        const followed = host.sink.since(0).filter((request) => request.path === STOLEN_PATH);
        assert(
          followed.length === 0,
          `micaOS followed the upload's redirect: ${describe(followed)}`
        );
      })
  },
  {
    // MICA-292, MICA-300: the character-deleted purge releases the deleted character's hosted
    // photos — and only those no other row still names. A proximity drop's copy on another
    // player's row keeps its file.
    id: 'http-character-deleted-asks-the-host-to-delete-its-photos',
    mode: 'standalone',
    tickets: ['MICA-292', 'MICA-300', 'MICA-243', 'MICA-304'],
    timeoutMs: 45_000,
    run: (signal) =>
      withImageHost(async (host) => {
        const tap = requireTap();
        const gone = await seedCitizen('http_gone');
        const keeper = unique('http_keeper');
        const lone = (await expectOk<{ id: number }>('AddMedia', gone.citizenid, PHOTO)).id;
        const shared = (await expectOk<{ id: number }>('AddMedia', gone.citizenid, PHOTO)).id;
        const loneName = await hostedName(lone);
        const sharedName = await hostedName(shared);
        const copy = await db.insert(
          "INSERT INTO `mica_media` (`citizenid`, `kind`, `url`) VALUES (?, 'photo', ?)",
          [keeper, `${FILES}${sharedName}`]
        );

        try {
          const mark = tap.mark();
          const from = host.sink.mark();
          emit('mica:server:shell:characterDeleted', gone.citizenid);
          const said = await tap.waitFor(
            mark,
            new RegExp(
              `^\\[mica\\] (purged \\d+ row\\(s\\)|purge for) .*${literal(gone.citizenid)}`
            ),
            30_000,
            signal,
            "the purge's summary"
          );
          assert(said.startsWith('[mica] purged'), said);

          const received = host.sink.since(from);
          const names = deletedNames(received);
          assert(
            names.includes(loneName),
            `the host was not asked to delete the deleted character's photo; it received ` +
              `${describe(received)}; micaOS said: ${mediaSaid(tap, mark)}`
          );
          assert(
            !names.includes(sharedName),
            "the host was asked to delete a photo another player's row still names"
          );
          assert(
            names.every((name) => name === loneName),
            `the host received deletes it did not expect: ${names.join(', ')}`
          );
          assert(
            received.every((request) => request.headers[KEY_HEADER.toLowerCase()] === host.secret),
            `a delete did not carry ${KEY_HEADER} with the configured value`
          );
          assert(
            tap.since(mark).includes('[micamedia] deleted 1 hosted photo(s) from the image host.'),
            `micaOS did not report one hosted photo deleted; it said: ${mediaSaid(tap, mark)}`
          );

          assert(!(await exists(lone)), "the deleted character's photo row survived");
          assert(
            !(await exists(shared)),
            "the deleted character's copy of the shared photo survived"
          );
          assert(await exists(copy), "the other player's copy of the photo was purged");
          assertNoLeak(tap, mark, host.secret);
        } finally {
          await db.exec('DELETE FROM `mica_media` WHERE `id` = ?', [copy]);
        }
      })
  },
  {
    // MICA-292: a host that refuses the delete, or hangs up on it, never fails the purge that
    // asked. The rows are gone, and the console says the files were left.
    id: 'http-host-refusing-deletes-still-purges-the-rows',
    mode: 'standalone',
    tickets: ['MICA-292', 'MICA-243', 'MICA-304'],
    timeoutMs: 45_000,
    run: (signal) =>
      withImageHost(async (host) => {
        const tap = requireTap();
        const who = await seedCitizen('http_refused_delete');
        const refused = (await expectOk<{ id: number }>('AddMedia', who.citizenid, PHOTO)).id;
        const dropped = (await expectOk<{ id: number }>('AddMedia', who.citizenid, PHOTO)).id;
        const refusedName = await hostedName(refused);
        const droppedName = await hostedName(dropped);
        host.onDelete((name) => (name === droppedName ? { drop: true } : { status: 500 }));

        const mark = tap.mark();
        const from = host.sink.mark();
        emit('mica:server:media:characterDeleted', who.citizenid);
        const said = await tap.waitFor(
          mark,
          new RegExp(
            `^\\[micamedia\\] (purged \\d+ row\\(s\\) for deleted character ${literal(who.citizenid)}\\.` +
              '|purge for a deleted character failed)'
          ),
          30_000,
          signal,
          "the media purge's summary"
        );
        assert(/purged 2 row\(s\)/.test(said), said);

        // The twin: both deletes reached the host, so the refusals were the host's to make.
        const names = deletedNames(host.sink.since(from));
        assert(
          names.includes(refusedName) && names.includes(droppedName),
          `the host was not asked to delete both photos; it was asked for: ` +
            `${names.join(', ') || 'nothing'}; micaOS said: ${mediaSaid(tap, mark)}`
        );
        assert(
          tap
            .since(mark)
            .includes(
              '[micamedia] 2 hosted photo(s) could not be deleted from the image host and ' +
                'are left there; their rows are already gone.'
            ),
          `micaOS did not report the two files left on the host; it said: ${mediaSaid(tap, mark)}`
        );
        assert(
          !tap.since(mark).some((line) => line.startsWith('[micamedia] deleted ')),
          'micaOS reported a hosted photo deleted although the host refused every delete'
        );
        assert(!(await exists(refused)), 'a photo row survived a purge whose delete was refused');
        assert(!(await exists(dropped)), 'a photo row survived a purge whose delete hung up');
        assertNoLeak(tap, mark, host.secret);
      })
  },
  {
    // MICA-322: `micahttp webhook` posts one labelled test embed through the webhook's own
    // request — POST, JSON, to the configured URL — and the console names the host, never the
    // token. Unset, it says so and sends nothing.
    id: 'http-micahttp-webhook-posts-a-test-embed',
    mode: 'standalone',
    tickets: ['MICA-322', 'MICA-242', 'MICA-304'],
    timeoutMs: 30_000,
    run: async (signal) => {
      const tap = requireTap();
      await withWebhook(async (hook) => {
        // Off first: the same sink, nothing sent.
        SetConvar('mica_discord_webhook', '');
        let mark = tap.mark();
        await runCommand('micahttp webhook');
        await tap.waitFor(
          mark,
          /^\[micahttp\] webhook: mica_discord_webhook is not set, so the webhook is off; nothing sent\.$/,
          10_000,
          signal,
          "micahttp's line for an unset webhook"
        );
        assert(
          hook.sink.since(0).length === 0,
          `an unset webhook sent ${describe(hook.sink.since(0))}`
        );

        // The twin: pointed at the sink, the post arrives.
        SetConvar('mica_discord_webhook', `${hook.sink.origin}${hook.path}`);
        mark = tap.mark();
        const from = hook.sink.mark();
        await runCommand('micahttp webhook');
        const post = await hook.sink.waitFor(
          from,
          (request) => request.path.startsWith(WEBHOOK_PREFIX),
          10_000,
          signal,
          `the webhook's test post (micaOS said: ${micahttpSaid(tap, mark)})`
        );
        assert(
          post.method === 'POST' && post.path === hook.path,
          `the test post was ${post.method} to a path other than the configured webhook's`
        );
        assert(
          post.headers['content-type'] === 'application/json',
          `the test post is typed ${String(post.headers['content-type'])}`
        );
        const body = jsonOf(post);
        assert(
          body.content === TEST_POST_CONTENT,
          `the post's content is ${JSON.stringify(body.content)}`
        );
        assert(
          Array.isArray(body.embeds) && body.embeds.length === 1,
          `the post carries ${Array.isArray(body.embeds) ? body.embeds.length : 'no'} embed(s), not 1`
        );
        assert(
          body.embeds?.[0]?.title === TEST_EMBED_TITLE,
          `the embed is titled ${JSON.stringify(body.embeds?.[0]?.title)}`
        );
        assert(
          hook.sink.since(from).length === 1,
          `one command sent ${describe(hook.sink.since(from))}`
        );

        await tap.waitFor(
          mark,
          new RegExp(
            `^\\[micahttp\\] webhook: posted the embed "${literal(TEST_EMBED_TITLE)}" to ` +
              `${ORIGIN}/${ELLIPSIS}; the host answered 204\\.$`
          ),
          10_000,
          signal,
          "micahttp's line for the post"
        );
        // The token was in play — the sink was asked for it — and the console never said it.
        assert(post.path.includes(hook.token), 'the post did not carry the configured token');
        assertNoToken(tap, mark, hook.token);
      });
    }
  },
  {
    // MICA-322: a 500 from either host is reported on the console and thrown nowhere, and the
    // command still works afterwards.
    id: 'http-micahttp-reports-a-500-without-throwing',
    mode: 'standalone',
    tickets: ['MICA-322', 'MICA-242', 'MICA-237', 'MICA-304'],
    timeoutMs: 45_000,
    run: async (signal) => {
      const tap = requireTap();
      await withWebhook(async (hook) => {
        hook.sink.respond((request) =>
          request.method === 'GET' ? { status: 500, json: [] } : { status: 500 }
        );

        let mark = tap.mark();
        let from = hook.sink.mark();
        await runCommand('micahttp webhook');
        await tap.waitFor(
          mark,
          new RegExp(
            `^\\[micahttp\\] webhook: posted the embed .* to ${ORIGIN}/${ELLIPSIS}; ` +
              'the host answered 500, so the post was refused\\.$'
          ),
          10_000,
          signal,
          "micahttp's line for a webhook answering 500"
        );
        // The twin: the host was asked, so the 500 was its to give.
        assert(
          hook.sink.since(from).some((request) => request.method === 'POST'),
          `the webhook was never asked; it received ${describe(hook.sink.since(from))}`
        );
        assert(
          !tap.since(mark).some((line) => THREW.test(line)),
          `a 500 from the webhook threw: ${tap
            .since(mark)
            .filter((l) => THREW.test(l))
            .join(' | ')}`
        );
        assertNoToken(tap, mark, hook.token);

        await withCatalog(`${hook.sink.origin}/addons/failing.json`, async () => {
          mark = tap.mark();
          from = hook.sink.mark();
          await runCommand('micahttp catalog');
          await tap.waitFor(
            mark,
            new RegExp(
              `^\\[micahttp\\] catalog: ${ORIGIN}/addons/failing\\.json \\(custom\\) is ` +
                'unavailable: the host answered 500\\. '
            ),
            15_000,
            signal,
            "micahttp's line for a catalog answering 500"
          );
          assert(
            hook.sink
              .since(from)
              .some((r) => r.method === 'GET' && r.path === '/addons/failing.json'),
            `the catalog was never asked; the sink received ${describe(hook.sink.since(from))}`
          );
          assert(
            !tap.since(mark).some((line) => THREW.test(line)),
            `a 500 from the catalog threw: ${tap
              .since(mark)
              .filter((l) => THREW.test(l))
              .join(' | ')}`
          );
        });

        // And the command is still standing: the same webhook, answering 204, is posted to.
        hook.sink.respond(() => ({ status: 204 }));
        mark = tap.mark();
        await runCommand('micahttp webhook');
        await tap.waitFor(
          mark,
          /^\[micahttp\] webhook: posted the embed .* the host answered 204\.$/,
          10_000,
          signal,
          "micahttp's line for the post after the 500"
        );
        assertNoToken(tap, mark, hook.token);
      });
    }
  },
  {
    // MICA-322: a webhook that redirects is refused, not followed. Fetch re-sends a POST's body
    // on a 307 or 308, so following would hand the staff channel's embeds to a host the owner
    // never named.
    id: 'http-micahttp-webhook-refuses-a-redirect',
    mode: 'standalone',
    tickets: ['MICA-322', 'MICA-242', 'MICA-304'],
    timeoutMs: 30_000,
    run: async (signal) => {
      const tap = requireTap();
      await withWebhook(async (hook) => {
        hook.sink.respond((request) =>
          request.path === STOLEN_PATH
            ? { status: 204 }
            : { status: 307, headers: { Location: `${hook.sink.origin}${STOLEN_PATH}` } }
        );
        const mark = tap.mark();
        const from = hook.sink.mark();
        await runCommand('micahttp webhook');
        const said = await tap.waitFor(
          mark,
          new RegExp(`^\\[micahttp\\] webhook: the post to ${ORIGIN}/${ELLIPSIS} failed: `),
          10_000,
          signal,
          "micahttp's line for a redirecting webhook"
        );
        assert(/redirect/i.test(said), `micaOS gave the reason '${said}'`);
        // The twin: the webhook itself was asked, so there was a redirect to follow.
        const received = hook.sink.since(from);
        assert(
          received.some((request) => request.method === 'POST' && request.path === hook.path),
          `the webhook was never asked; the sink received ${describe(received)}`
        );
        assert(
          !received.some((request) => request.path === STOLEN_PATH),
          `micaOS followed the webhook's redirect: ${describe(received)}`
        );
        assertNoToken(tap, mark, hook.token);
      });
    }
  },
  {
    // MICA-322, MICA-237: `micahttp catalog` fetches the catalog through the Store's own request
    // — GET, Accept: application/json — past the cache each time, names what it found, and
    // refuses a redirect without following it.
    id: 'http-micahttp-catalog-fetches-from-the-sink',
    mode: 'standalone',
    tickets: ['MICA-322', 'MICA-237', 'MICA-304'],
    timeoutMs: 45_000,
    run: (signal) =>
      withSink(async (sink) => {
        const tap = requireTap();
        sink.respond((request) =>
          request.path === '/addons/moved.json'
            ? { status: 302, headers: { Location: `${sink.origin}${STOLEN_PATH}` } }
            : request.path === '/addons/catalog.json'
              ? { status: 200, json: [{ id: 'itx-weather' }, { id: 'itx-radio' }] }
              : { status: 404 }
        );

        await withCatalog(`${sink.origin}/addons/catalog.json`, async () => {
          for (const round of ['first', 'second']) {
            const mark = tap.mark();
            const from = sink.mark();
            await runCommand('micahttp catalog');
            const request = await sink.waitFor(
              from,
              (each) => each.path === '/addons/catalog.json',
              15_000,
              signal,
              `the ${round} catalog fetch (micaOS said: ${micahttpSaid(tap, mark)})`
            );
            assert(request.method === 'GET', `the catalog was fetched with ${request.method}`);
            assert(
              request.headers.accept === 'application/json',
              `the catalog was asked for ${String(request.headers.accept)}`
            );
            await tap.waitFor(
              mark,
              new RegExp(
                `^\\[micahttp\\] catalog: fetched ${ORIGIN}/addons/catalog\\.json \\(custom\\): ` +
                  '2 entries \\(itx-weather, itx-radio\\)\\. '
              ),
              10_000,
              signal,
              `micahttp's line for the ${round} fetch`
            );
          }
        });

        await withCatalog(`${sink.origin}/addons/moved.json`, async () => {
          const mark = tap.mark();
          const from = sink.mark();
          await runCommand('micahttp catalog');
          await tap.waitFor(
            mark,
            new RegExp(
              `^\\[micahttp\\] catalog: ${ORIGIN}/addons/moved\\.json \\(custom\\) is unavailable: `
            ),
            15_000,
            signal,
            "micahttp's line for a redirecting catalog"
          );
          // The twin: the redirect was asked for, so not following it was micaOS's choice.
          assert(
            sink.since(from).some((r) => r.path === '/addons/moved.json'),
            `the redirecting catalog was never asked; the sink received ${describe(sink.since(from))}`
          );
          assert(
            !sink.since(from).some((r) => r.path === STOLEN_PATH),
            "micaOS followed the catalog's redirect"
          );
        });
      })
  },
  {
    // MICA-292, MICA-300: the orphan sweep, which on a framework is the cleanup after a
    // character the framework deleted, releases the orphan's hosted photos — again only those
    // no remaining row names. Standalone has no owner table, so the sweep runs only here.
    id: 'qbx-orphan-sweep-asks-the-host-to-delete-orphaned-photos',
    mode: 'qbx',
    tickets: ['MICA-292', 'MICA-300', 'MICA-304'],
    timeoutMs: 60_000,
    run: async (signal) => {
      await schemaCreated(signal);
      // Plant no orphan while micaOS's own start-up sweep is still going: it could take them
      // first, and the deletes would land before this scenario's mark. See bootSweep.ts.
      await bootOrphanSweepEnded(requireTap(), 10_000, signal);
      await withImageHost(async (host) => {
        const tap = requireTap();
        const orphan = unique('http_orphan');
        const loneName = fileName();
        const sharedName = fileName();
        const row = (citizenid: string, name: string): Promise<number> =>
          db.insert(
            "INSERT INTO `mica_media` (`citizenid`, `kind`, `url`) VALUES (?, 'photo', ?)",
            [citizenid, `${FILES}${name}`]
          );
        // The seeded character's row is also what lets the sweep run at all: it samples owners
        // from mica_media and refuses when not one of them is in `players`.
        const kept = await row(QBX_SEED.citizenid, sharedName);
        const lone = await row(orphan, loneName);
        const shared = await row(orphan, sharedName);

        try {
          const mark = tap.mark();
          const from = host.sink.mark();
          // Asked again while micaOS's own retention pass holds mica_media; see mediaPrune.ts.
          const done = await runMediaPrune(tap, 45_000, signal);
          assert(done.startsWith('[micamedia] prune finished: '), done);

          assert(
            !(await exists(lone)) && !(await exists(shared)),
            `the orphan's rows survived the sweep; micaOS said: ${mediaSaid(tap, mark)}`
          );
          assert(await exists(kept), "the seeded character's photo row was swept");

          const received = host.sink.since(from);
          const names = deletedNames(received);
          assert(
            names.includes(loneName),
            `the host was not asked to delete the orphan's photo; it received ` +
              `${describe(received)}; micaOS said: ${mediaSaid(tap, mark)}`
          );
          assert(
            !names.includes(sharedName),
            "the host was asked to delete a photo the seeded character's row still names"
          );
          assert(
            received.every((request) => request.headers[KEY_HEADER.toLowerCase()] === host.secret),
            `a delete did not carry ${KEY_HEADER} with the configured value`
          );
          assert(
            tap.since(mark).includes('[micamedia] deleted 1 hosted photo(s) from the image host.'),
            `micaOS did not report one hosted photo deleted; it said: ${mediaSaid(tap, mark)}`
          );
          assertNoLeak(tap, mark, host.secret);
        } finally {
          await db.exec('DELETE FROM `mica_media` WHERE `id` IN (?, ?, ?)', [kept, lone, shared]);
        }
      });
    }
  }
];
