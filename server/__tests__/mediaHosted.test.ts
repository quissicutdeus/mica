// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-293: two follow-ups to hosting photos off the database (MICA-243, MICA-292).
 *
 * - **A hosted row counts against the quota.** Its `data` is empty, so measuring the row
 *   alone charged only the thumbnail and left the rate limiter as the only cap on a player's
 *   uploads to the owner's host. It now costs `byte_size` where the upload recorded it and
 *   `NOMINAL_HOSTED_BYTES` where nothing did — which is every hosted row written before this.
 * - **A proximity drop cannot hand recipients a deleted file.** `drop` read the sender's row,
 *   looked for who was nearby, then wrote copies from what it had read; retention deleting
 *   that row and releasing its file in between left every copy pointing at nothing.
 *
 * `Database` is mocked, so no SQL is evaluated here. The quota is asserted on what the
 * statements carry and on `storedBytesOf`; that the SQL and `storedBytesOf` agree to the byte,
 * and that the copy really selects nothing once its source is gone, is `pnpm test:schema`'s
 * part, against MariaDB. The race below is interleaved deterministically against a small
 * in-memory table that answers the copy the way the statement asks it to.
 */
const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const handlers = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return captured;
});

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CID_A', source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => 5,
    getSourcesByCitizenId: (citizenids: readonly string[]) =>
      new Map(citizenids.map((cid) => [cid, cid === 'CID_B' ? 9 : 11])),
    registerUsableItem: () => {}
  }
}));

/**
 * The drop's one await between reading the sender's row and writing the copies, held open
 * by the test so the release can be placed exactly inside it.
 */
const nearby = vi.hoisted(() => ({
  players: [] as { source: number; citizenid: string }[],
  gate: null as Promise<void> | null,
  reached: null as (() => void) | null
}));
vi.mock('../lib/proximity', () => ({
  findNearbyVisiblePlayers: vi.fn(async () => {
    nearby.reached?.();
    if (nearby.gate) await nearby.gate;
    return nearby.players;
  })
}));

import { releaseHostedImages, resetMediaHostForTests } from '../lib/mediaHost';
import {
  hostedUrlPrefixes,
  mediaStorageStats,
  NOMINAL_HOSTED_BYTES,
  storedBytesOf
} from '../services/Media';

const CREATE_EVENT = 'mica:server:media:create';
const DROP_EVENT = 'mica:server:media:drop';

const HOST = 'img.example.test';
const PREFIX = `https://${HOST}/`;
const HOSTED = `${PREFIX}p/abc.webp`;
const OLD_PREFIX = 'https://old.example.test/';
const MB = 1024 * 1024;

/** A decoded payload of a known size, so the charged size is checkable. */
const FILE = 'x'.repeat(1234);
const PHOTO = `data:image/webp;base64,${btoa(FILE)}`;

let fetchMock: ReturnType<typeof vi.fn>;
let convars: Record<string, string> = {};

const hosting = () => {
  convars = {
    mica_media_upload_url: 'https://api.example.test/upload',
    mica_media_image_host: HOST,
    mica_media_delete_url: 'https://api.example.test/files/{name}'
  };
};

const call = async (event: string, data: unknown) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

const deletesRequested = (): string[] =>
  fetchMock.mock.calls
    .filter((c: any[]) => c[1]?.method === 'DELETE')
    .map((c: any[]) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  resetMediaHostForTests();
  convars = {};
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in convars ? convars[name] : fallback;
  (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
    name in convars ? Number(convars[name]) || 0 : fallback;
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(99);
  dbMock.single.mockResolvedValue(null);
  fetchMock = vi.fn(async (_url: string, init: { method: string }) =>
    init.method === 'POST'
      ? { ok: true, status: 200, json: async () => ({ url: HOSTED }) }
      : { ok: true, status: 200, json: async () => ({}) }
  );
  vi.stubGlobal('fetch', fetchMock);
  nearby.players = [];
  nearby.gate = null;
  nearby.reached = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what a hosted row costs', () => {
  it('charges the size the upload recorded, on top of anything inline', () => {
    const row = { url: HOSTED, byte_size: 5000, thumbnail: 'thumb' };
    expect(storedBytesOf(row, [PREFIX])).toBe(5000 + 'thumb'.length);
  });

  it('charges the nominal size for a hosted row with no recorded size, as every older one is', () => {
    expect(storedBytesOf({ url: HOSTED, byte_size: null as any }, [PREFIX])).toBe(
      NOMINAL_HOSTED_BYTES
    );
    expect(storedBytesOf({ url: HOSTED }, [PREFIX])).toBe(NOMINAL_HOSTED_BYTES);
  });

  it('charges a photo on a former image host the same way', () => {
    const prefixes = [PREFIX, OLD_PREFIX];
    expect(storedBytesOf({ url: `${OLD_PREFIX}p/1.webp` }, prefixes)).toBe(NOMINAL_HOSTED_BYTES);
  });

  it('still charges nothing for a hotlink that is not on an image host', () => {
    expect(storedBytesOf({ url: 'https://giphy.test/a.gif' }, [PREFIX])).toBe(0);
    // Nor for a lookalike: the prefix ends at the host's own slash.
    expect(storedBytesOf({ url: `https://${HOST}.evil.test/a.webp` }, [PREFIX])).toBe(0);
  });

  it('never lets a recorded size below zero hand back room', () => {
    expect(storedBytesOf({ url: HOSTED, byte_size: -10 * MB }, [PREFIX])).toBe(0);
  });

  it('charges nothing extra when there has never been a host', () => {
    expect(storedBytesOf({ url: HOSTED, byte_size: 5000 }, [])).toBe(0);
  });
});

describe('which URLs are hosted', () => {
  it('is the current host and every host the ledger recorded, sorted', async () => {
    hosting();
    dbMock.query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT `id` FROM `mica_schema_migrations`')
        ? [{ id: 'mediahost:old.example.test' }]
        : []
    );

    expect(await hostedUrlPrefixes()).toEqual([PREFIX, OLD_PREFIX]);
  });

  it('keeps counting a former host after uploads are turned off', async () => {
    dbMock.query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT `id` FROM `mica_schema_migrations`')
        ? [{ id: 'mediahost:old.example.test' }]
        : []
    );

    expect(await hostedUrlPrefixes()).toEqual([OLD_PREFIX]);
  });
});

describe('a hosted capture is held to the quota', () => {
  const lastInsert = () => {
    const [sql, params] = dbMock.insert.mock.calls.at(-1)!;
    return { sql: String(sql).replace(/\s+/g, ' '), params: params as unknown[] };
  };

  it('records the uploaded size on the row and charges exactly that', async () => {
    hosting();

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toBeUndefined();
    const { sql, params } = lastInsert();
    const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(', ');
    expect(params[columns.indexOf('`byte_size`')]).toBe(FILE.length);
    expect(params[columns.indexOf('`url`')]).toBe(HOSTED);
    // Owner, incoming size and ceiling, as before: the incoming size is the file's.
    expect(params.slice(-3)).toEqual(['CID_A', FILE.length, 64 * MB]);
  });

  it("measures the player's existing hosted rows in the same statement", async () => {
    hosting();

    await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    const { sql, params } = lastInsert();
    expect(sql).toContain('CAST(url AS BINARY) LIKE ?');
    expect(sql).toContain(`IFNULL(byte_size, ${NOMINAL_HOSTED_BYTES})`);
    expect(params).toContain(`${PREFIX}%`);
    // Every placeholder bound: the prefix is a value, never part of the statement text.
    expect(sql.split('?').length - 1).toBe(params.length);
    expect(sql).not.toContain(HOST);
  });

  it('refuses a hosted capture the ceiling turned away, and releases the uploaded file', async () => {
    hosting();
    dbMock.insert.mockResolvedValue(0);

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toMatch(/full/i);
    expect(deletesRequested()).toEqual(['https://api.example.test/files/abc.webp']);
  });

  /**
   * Ponds' review of MICA-293: a player at their ceiling used to post every capture to the
   * owner's host, be refused by the insert, and have the file deleted again. The pre-check
   * refuses first; the insert stays the authority.
   */
  const uploads = () => fetchMock.mock.calls.filter((c: any[]) => c[1]?.method === 'POST');
  const usedSoFar = (bytes: number) =>
    dbMock.scalar.mockImplementation(async (sql: string) =>
      String(sql).startsWith('SELECT COALESCE(SUM(') ? bytes : null
    );

  it('refuses a capture with no room before anything is posted to the host', async () => {
    hosting();
    usedSoFar(64 * MB - FILE.length + 1);

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(reply.error).toMatch(/full/i);
    expect(uploads()).toHaveLength(0);
    expect(deletesRequested()).toEqual([]);
    expect(dbMock.insert).not.toHaveBeenCalled();
    // Measured the way the insert measures: the player, and the hosted rows at their cost.
    const [sql, params] = dbMock.scalar.mock.calls[0];
    expect(String(sql)).toContain('CAST(url AS BINARY) LIKE ?');
    expect(params).toEqual([`${PREFIX}%`, 'CID_A']);
  });

  it('lets a capture that just fits upload, and still leaves the decision to the insert', async () => {
    hosting();
    usedSoFar(64 * MB - FILE.length);
    // The library filled between the pre-check and the write: the insert refuses anyway.
    dbMock.insert.mockResolvedValue(0);

    const reply = await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(uploads()).toHaveLength(1);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.insert.mock.calls[0][0]).toContain('WHERE quota.used + ? <= ?');
    expect(reply.error).toMatch(/full/i);
    expect(deletesRequested()).toEqual(['https://api.example.test/files/abc.webp']);
  });

  it('costs an install with no host no extra statement per capture', async () => {
    await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('adds no hosted term at all on an install that never had a host', async () => {
    await call(CREATE_EVENT, { kind: 'photo', data: PHOTO });

    expect(lastInsert().sql).not.toContain('CAST(');
  });

  it('reports storage in micamedia with the same cost the quota charges', async () => {
    hosting();
    dbMock.single.mockResolvedValue({ rowCount: 1, totalBytes: 10 });

    await mediaStorageStats();

    const [totals, totalsParams] = dbMock.single.mock.calls[0];
    expect(String(totals)).toContain('CAST(url AS BINARY) LIKE ?');
    expect(totalsParams).toEqual([`${PREFIX}%`]);
    const holders = dbMock.query.mock.calls.find((c) => String(c[0]).includes('GROUP BY'))!;
    expect(holders[1]).toEqual([`${PREFIX}%`]);
  });
});

/**
 * The race, interleaved. A tiny `mica_media`: the sender's hosted photo, and whatever copies
 * the drop writes. It answers the three statements that matter the way MariaDB would:
 *
 * - `findById` (`single`) finds the source row while it exists;
 * - the copy (`insert`) writes a recipient row — but when the statement carries the source
 *   predicate, only if that row still exists, which is what the predicate asks;
 * - the release's reference check (`query`) answers which URLs a remaining row still names.
 *
 * "Retention" here is what every hard delete of media does (MICA-292): delete the row, then
 * `releaseHostedImages` its URL. It is called directly, so the release is the real one.
 */
describe('a drop racing a release', () => {
  /** The predicate that makes a copy conditional on its source; nothing else counts as one. */
  const SOURCE_STILL_THERE = "src.`id` = ? AND src.`citizenid` = ? AND src.`status` = 'active'";

  interface Row {
    id: number;
    citizenid: string;
    url: string;
    status: string;
  }
  let rows: Row[];

  const table = () => {
    rows = [{ id: 42, citizenid: 'CID_A', url: HOSTED, status: 'active' }];
    let nextId = 100;
    dbMock.single.mockImplementation(async (_sql: string, params: unknown[]) => {
      const row = rows.find((r) => r.id === params[0] && r.citizenid === params[1]);
      return row ? { ...row, kind: 'photo', data: null, thumbnail: null, byte_size: 1000 } : null;
    });
    dbMock.insert.mockImplementation(async (sql: string, params: unknown[]) => {
      const recipient = params[0] as string;
      if (String(sql).includes(SOURCE_STILL_THERE)) {
        // The copy names its source by id and owner; it exists only while that row does.
        expect(params).toContain(42);
        expect(params).toContain('CID_A');
        const source = rows.find((r) => r.id === 42 && r.status === 'active');
        if (!source) return 0;
        rows.push({ id: nextId, citizenid: recipient, url: source.url, status: 'active' });
      } else {
        // A copy written from values read earlier, whatever happened to its source since.
        const url = params.find((p) => typeof p === 'string' && p.startsWith('https://'));
        rows.push({ id: nextId, citizenid: recipient, url: url as string, status: 'active' });
      }
      return nextId++;
    });
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT DISTINCT `url` FROM `mica_media` WHERE `url` IN')) {
        const live = new Set(rows.map((r) => r.url));
        return params.filter((url) => live.has(url as string)).map((url) => ({ url }));
      }
      return [];
    });
  };

  /** What retention does to the sender's row: hard-delete it, then release its file. */
  const retention = async () => {
    rows = rows.filter((r) => r.id !== 42);
    return await releaseHostedImages([HOSTED]);
  };

  /** Start a drop and stop it between reading the sender's row and writing the copies. */
  const dropHeldOpen = async () => {
    let release!: () => void;
    nearby.gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (nearby.reached = resolve));
    const reply = call(DROP_EVENT, { mediaId: 42 });
    await reached;
    return { reply, finish: release };
  };

  for (const quota of ['on', 'off'] as const) {
    describe(`with the quota ${quota}`, () => {
      beforeEach(() => {
        hosting();
        if (quota === 'off') convars.mica_media_quota_mb = '0';
        table();
        nearby.players = [
          { source: 9, citizenid: 'CID_B' },
          { source: 11, citizenid: 'CID_C' }
        ];
      });

      it('writes no copy of a row retention deleted mid-drop, and tells nobody', async () => {
        const drop = await dropHeldOpen();

        // The sender's row goes and its file is released while the drop is between its read
        // and its write — the window MICA-293 is about.
        const outcome = await retention();
        expect(outcome.deleted).toBe(1);
        expect(deletesRequested()).toEqual(['https://api.example.test/files/abc.webp']);

        drop.finish();
        const reply = await drop.reply;

        // No recipient holds a row pointing at the file that was just deleted.
        expect(rows.filter((r) => r.url === HOSTED)).toEqual([]);
        expect(reply).toEqual({ count: 0 });
        const pushes = (globalThis.emitNet as any).mock.calls.filter(
          (args: unknown[]) => args[0] === 'mica:client:shell:appEvent'
        );
        expect(pushes).toHaveLength(0);
      });

      it('keeps the file when the copies landed first, because they still name it', async () => {
        const reply = await call(DROP_EVENT, { mediaId: 42 });
        expect(reply).toEqual({ count: 2 });

        const outcome = await retention();

        expect(outcome.deleted).toBe(0);
        expect(deletesRequested()).toEqual([]);
        expect(rows.map((r) => r.citizenid).sort()).toEqual(['CID_B', 'CID_C']);
      });
    });
  }
});
