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
import { eventually } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * What micaOS sends over HTTP, received by a stub HTTPS server inside this resource
 * (`lib/httpSink.ts`, MICA-304) and checked request by request.
 *
 * **Only the image host is here** (MICA-243, MICA-292). Of micaOS's three outbound callers it is
 * the one a server reaches with no player connected: `AddMedia` uploads, and the purge, the
 * media-only purge and the orphan sweep release. The other two cannot be driven from here:
 *
 * - The Discord webhook (MICA-242) mirrors audit-ledger entries, and every staff-relevant entry
 *   is written by a player's net event (a moderation, a report read, an admin's conversation
 *   delete) behind `ServiceEndpoint`'s player lookup. No export and no console command writes one.
 * - The add-on catalog relay (MICA-237) answers `store:catalog`, a player's net event, and
 *   nothing else calls it.
 *
 * Both wait for a harness that can connect a client. Until then `integrationHttpSink.test.ts`
 * runs their real modules against this same sink under real Node `fetch`, outside FXServer.
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
    // MICA-292, MICA-300: the orphan sweep, which on a framework is the cleanup after a
    // character the framework deleted, releases the orphan's hosted photos — again only those
    // no remaining row names. Standalone has no owner table, so the sweep runs only here.
    id: 'qbx-orphan-sweep-asks-the-host-to-delete-orphaned-photos',
    mode: 'qbx',
    tickets: ['MICA-292', 'MICA-300', 'MICA-304'],
    timeoutMs: 60_000,
    run: async (signal) => {
      await schemaCreated(signal);
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
          await runCommand('micamedia prune');
          const done = await tap.waitFor(
            mark,
            /^\[micamedia\] (prune finished: |a retention prune of mica_media is already running)/,
            45_000,
            signal,
            "micamedia prune's summary"
          );
          assert(done.includes('prune finished'), done);

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
