// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const bridge = vi.hoisted(() => ({ citizenid: 'CID_A', online: {} as Record<string, number> }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.citizenid, source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => 5,
    /**
     * `pushMany` resolves the whole fan-out through this one call — that is the point of
     * it (§8) — so a drop's notifications are only observable here if the recipients
     * actually resolve to a source. An empty map is every recipient offline, which is a
     * legitimate outcome and was silently the only one this suite could see.
     */
    getSourcesByCitizenId: (citizenids: readonly string[]) =>
      new Map(
        citizenids.filter((cid) => cid in bridge.online).map((cid) => [cid, bridge.online[cid]])
      ),
    registerUsableItem: () => {}
  }
}));

const proximity = vi.hoisted(() => ({ nearby: [] as { source: number; citizenid: string }[] }));
vi.mock('../lib/proximity', () => ({
  findNearbyVisiblePlayers: vi.fn(async () => proximity.nearby)
}));

import '../services/Media';

const CREATE_EVENT = 'gphone:server:media:create';
const DROP_EVENT = 'gphone:server:media:drop';
const SHARE_LOCATION_EVENT = 'gphone:server:media:shareLocation';
const GET_EVENT = 'gphone:server:media:get';
const ITEM_EVENT = 'gphone:server:media:item';
const THUMBNAIL_EVENT = 'gphone:server:media:thumbnail';
const RESTORE_EVENT = 'gphone:server:media:restore';

const call = async (event: string, data: unknown) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

const callCreate = (data: unknown) => call(CREATE_EVENT, data);
const callDrop = (data: unknown) => call(DROP_EVENT, data);
const callShareLocation = (data: unknown) => call(SHARE_LOCATION_EVENT, data);
const callGet = (data: unknown) => call(GET_EVENT, data);
const callItem = (data: unknown) => call(ITEM_EVENT, data);
const callThumbnail = (data: unknown) => call(THUMBNAIL_EVENT, data);
const callRestore = (data: unknown) => call(RESTORE_EVENT, data);

/** A one-pixel PNG — the shape store-back accepts, and nothing larger. */
const TINY_STILL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/**
 * `playerCoords` guards on these natives existing at all, so a test environment with none
 * of them defined always resolves `null` — exactly the "could not determine your location"
 * path. Setting them here is what lets the happy-path tests reach past that guard.
 */
const natives = vi.hoisted(() => ({ coords: [100, 200, 30] as [number, number, number] | null }));
const setPlayerPed = () => {
  (globalThis as any).GetPlayerPed = () => 77;
  (globalThis as any).DoesEntityExist = () => true;
  (globalThis as any).GetEntityCoords = () => natives.coords;
};
const clearPlayerPed = () => {
  delete (globalThis as any).GetPlayerPed;
  delete (globalThis as any).DoesEntityExist;
  delete (globalThis as any).GetEntityCoords;
};

const OWNED_ROW = {
  id: 42,
  citizenid: 'CID_A',
  kind: 'photo',
  data: 'base64-bytes',
  url: null,
  thumbnail: null,
  mime_type: null,
  width: null,
  height: null,
  duration_ms: null,
  byte_size: null,
  alt_text: null,
  status: 'active'
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.single.mockReset();
  dbMock.insert.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(99);
  bridge.citizenid = 'CID_A';
  bridge.online = { CID_B: 9, CID_C: 11 };
  proximity.nearby = [];
  natives.coords = [100, 200, 30];
  clearPlayerPed();
});

describe('media:drop', () => {
  it('rejects a mediaId that is not a positive integer', async () => {
    const reply = await callDrop({ mediaId: -1 });
    expect(reply.error).toMatch(/mediaId/);
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('refuses a mediaId the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await callDrop({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a moderated photo, even though the owner can still find it by id', async () => {
    // findById scopes by citizenid but not by status, so a row a moderator pulled from
    // every ordinary read is still reachable by id — this is the one place that has to
    // check status itself rather than trusting the ownership predicate alone.
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status: 'moderated' });

    const reply = await callDrop({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a photo the owner has already deleted', async () => {
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status: 'deleted' });

    const reply = await callDrop({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('copies the row to each nearby, visible player and reports the count', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];

    const reply = await callDrop({ mediaId: 42 });

    expect(reply).toEqual({ count: 2 });
    // One statement per recipient since MICA-131 — see the test below for why.
    const written = dbMock.insert.mock.calls.map((c: unknown[]) => (c[1] as unknown[])[0]);
    expect(written).toContain('CID_B');
    expect(written).toContain('CID_C');
    // The sender is never a recipient of their own drop.
    expect(written).not.toContain('CID_A');
  });

  /**
   * MICA-115 made every recipient one row of a single multi-row `INSERT … VALUES`,
   * because each had been its own `await repo.create(...)` — that many *sequential* round
   * trips before the sender's tap answered.
   *
   * MICA-131 traded the single statement back for one per recipient, and the trade is
   * the point: a `VALUES` list cannot carry a per-row predicate, so the recipient's own
   * quota had to be measured in a separate statement beforehand — which is the race. These
   * are issued concurrently rather than in a loop of awaits, so the objection MICA-115
   * was written against does not come back with them, and the fan-out is capped at 16 by
   * `proximity.MAX_NEARBY`.
   */
  it('writes one conditional statement per recipient, each carrying its own ceiling', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];

    await callDrop({ mediaId: 42 });

    expect(dbMock.insert).toHaveBeenCalledTimes(2);
    for (const [sql, params] of dbMock.insert.mock.calls) {
      // A stub cannot enforce a predicate, so what is asserted is that the statement
      // carries one — the decision is in the write rather than in front of it.
      expect(String(sql)).toContain('SUM(');
      expect(String(sql).replace(/\s+/g, ' ')).toContain('WHERE quota.used + ? <= ?');
      // Every placeholder is bound, which is what keeps the statement parameterized.
      expect(String(sql).split('?').length - 1).toBe((params as unknown[]).length);
    }
  });

  it('reports only the copies the database actually wrote', async () => {
    // The interleaving the pre-check lost to: two senders both measured one bystander as
    // having room, and both wrote. The predicate is what refuses the second, and the count
    // has to come from that rather than from the length of the recipient list — otherwise
    // a bystander with no row is still told a photo arrived.
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];
    dbMock.insert.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === 'CID_B' ? 0 : 77
    );

    const reply = await callDrop({ mediaId: 42 });

    expect(reply).toEqual({ count: 1 });
    const pushed = (globalThis.emitNet as any).mock.calls
      .filter((args: unknown[]) => args[0] === 'gphone:client:shell:appEvent')
      .map((args: unknown[]) => args[1]);
    // 9 is CID_B's source: refused a row, so refused a notification too.
    expect(pushed).not.toContain(9);
  });

  it('never lets a copy inherit the sender’s row id, status or timestamps', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await callDrop({ mediaId: 42 });

    const [sql, params] = dbMock.insert.mock.calls[0];
    // The **inserted column list** specifically, not the whole statement: since MICA-131
    // the quota subquery reads `status` legitimately, and asserting over the raw SQL would
    // now be satisfied or broken by a predicate that has nothing to do with what a copy
    // inherits.
    const columnList = String(sql).slice(String(sql).indexOf('('), String(sql).indexOf(')'));
    for (const column of ['`id`', '`status`', '`created_at`', '`updated_at`']) {
      expect(columnList, column).not.toContain(column);
    }
    expect(params as unknown[]).not.toContain(42);
  });

  it('writes one copy and sends one notification when two sources share a character', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 12, citizenid: 'CID_B' }
    ];

    const reply = await callDrop({ mediaId: 42 });

    expect(reply).toEqual({ count: 1 });
    const pushes = (globalThis.emitNet as any).mock.calls.filter(
      (args: unknown[]) => args[0] === 'gphone:client:shell:appEvent'
    );
    expect(pushes).toHaveLength(1);
  });

  it('notifies each recipient', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await callDrop({ mediaId: 42 });

    const push = (globalThis.emitNet as any).mock.calls.find(
      (args: unknown[]) => args[0] === 'gphone:client:shell:appEvent'
    );
    expect(push?.[2]).toMatchObject({ app: 'media', event: 'media_received' });
  });

  it('reports zero and writes nothing when nobody is nearby', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [];

    const reply = await callDrop({ mediaId: 42 });

    expect(reply).toEqual({ count: 0 });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('media:shareLocation', () => {
  it('refuses when the player position cannot be determined', async () => {
    // No GetPlayerPed/DoesEntityExist/GetEntityCoords defined — playerCoords resolves null.
    const reply = await callShareLocation({ label: 'Vinewood Blvd' });

    expect(reply.error).toMatch(/location/i);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('writes the row using the server-read position, never anything from the payload', async () => {
    setPlayerPed();
    natives.coords = [111, 222, 33];
    dbMock.insert.mockResolvedValueOnce(55);
    dbMock.single.mockResolvedValueOnce({
      ...OWNED_ROW,
      id: 55,
      kind: 'location',
      data: JSON.stringify({ x: 111, y: 222, z: 33 }),
      alt_text: 'Vinewood Blvd'
    });

    const reply = await callShareLocation({ label: 'Vinewood Blvd' });

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    const [, params] = dbMock.insert.mock.calls[0];
    expect(params as unknown[]).not.toContain(999);
    expect(JSON.stringify(params)).toContain('111');
    expect(JSON.stringify(params)).toContain('222');
    expect(JSON.stringify(params)).toContain('33');

    expect(reply).toEqual({
      id: 55,
      media: expect.objectContaining({ id: 55, kind: 'location' })
    });
  });

  it('refuses a payload smuggling its own coordinates, rather than ignoring it', async () => {
    /**
     * The handler only ever read `label`, so extra keys were inert — but "inert" and
     * "refused" are different promises, and only one of them survives somebody adding a
     * field to the schema later. The contract declares `label` and nothing else, so a
     * payload naming x/y/z never reaches the handler at all.
     */
    setPlayerPed();

    const reply = await callShareLocation({ label: 'Vinewood Blvd', x: 999, y: 999, z: 999 });

    expect(reply.error).toMatch(/x/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses an over-long label rather than silently truncating it', async () => {
    /**
     * It used to `slice(0, 255)`, which is the same failure MySQL's non-strict mode
     * produces: the row is written, the write reports success, and the stored value is not
     * the one that was sent. `alt_text` is a varchar(255) and the contract says so.
     */
    setPlayerPed();

    const reply = await callShareLocation({ label: 'x'.repeat(400) });

    expect(reply.error).toMatch(/label/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('drops a non-string or empty label rather than writing it as-is', async () => {
    setPlayerPed();
    dbMock.insert.mockResolvedValueOnce(57);
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, id: 57, kind: 'location' });

    await callShareLocation({ label: '   ' });

    const [, params] = dbMock.insert.mock.calls[0];
    expect(params as unknown[]).not.toContain('   ');
  });
});

/**
 * MICA-110. The gallery downloaded every original at full size to draw a grid of 123px
 * tiles, because the owner read selected every column and the table's `data` column is a
 * whole base64 photo.
 *
 * Every assertion here is on the **SQL**, not on the object that comes back. Withholding a
 * column by deleting it from the result would leave the bytes crossing the driver and the
 * server anyway, and would be undone by any repository override that reshapes rows — the
 * point is a query that never asks for them.
 */
describe('media:get — the list read (MICA-110)', () => {
  const listSql = (): string => dbMock.query.mock.calls.at(-1)?.[0] as string;

  it('never selects the photo bytes', async () => {
    await callGet({});

    expect(listSql()).not.toMatch(/`data`/);
    // And it is a real projection rather than the old `SELECT *`, which would have every
    // column back without naming one.
    expect(listSql()).not.toContain('SELECT *');
  });

  it('still selects everything a grid tile needs to draw itself', async () => {
    await callGet({});

    for (const column of ['id', 'kind', 'thumbnail', 'url', 'mime_type', 'created_at']) {
      expect(listSql(), column).toContain(`\`${column}\``);
    }
  });

  it('keeps the ownership predicate and the active filter', async () => {
    await callGet({});

    expect(listSql()).toContain('`citizenid` = ?');
    const params = dbMock.query.mock.calls.at(-1)?.[1] as unknown[];
    expect(params).toContain('CID_A');
    expect(params).toContain('active');
  });

  it('pages keyset on id DESC rather than returning the whole library', async () => {
    await callGet({});

    expect(listSql()).toContain('ORDER BY `id` DESC');
    expect(listSql()).toContain('LIMIT ?');
    // pageSize 30, plus the one over-fetched row that answers "is there more?".
    expect(dbMock.query.mock.calls.at(-1)?.[1]).toContain(31);
  });

  it('reports a next cursor while there is another page, and null at the end', async () => {
    const page = Array.from({ length: 31 }, (_, i) => ({ ...OWNED_ROW, id: 100 - i }));
    dbMock.query.mockResolvedValueOnce(page);

    const reply = await callGet({});

    // The over-fetched 31st row is dropped rather than returned, and the cursor is the id
    // of the last row actually delivered.
    expect(reply.rows).toHaveLength(30);
    expect(reply.nextCursor).toBe(71);

    dbMock.query.mockResolvedValueOnce([{ ...OWNED_ROW, id: 5 }]);
    expect((await callGet({})).nextCursor).toBeNull();
  });

  it('clamps a limit the payload asked for to the declared maximum', async () => {
    await callGet({ limit: 5000 });

    // maxPageSize 60, over-fetched by one.
    expect(dbMock.query.mock.calls.at(-1)?.[1]).toContain(61);
  });

  it('takes a cursor as a row id and never as a column to sort by', async () => {
    await callGet({ cursor: 40, sort: 'citizenid' });

    expect(listSql()).toContain('`id` < ?');
    // The sort column comes from the declaration. A payload that offers one is ignored
    // rather than honored, which is why the cursor is an integer and not an opaque string.
    expect(listSql()).toContain('ORDER BY `id` DESC');
    expect(listSql()).not.toMatch(/ORDER BY(?!\s+`id` DESC)/);
    expect(dbMock.query.mock.calls.at(-1)?.[1]).toContain(40);
    expect(dbMock.query.mock.calls.at(-1)?.[1]).not.toContain('citizenid');
  });

  it('refuses a cursor that is not a row id', async () => {
    const reply = await callGet({ cursor: 'id; DROP TABLE gphone_media' });

    expect(reply.error).toMatch(/cursor/i);
  });
});

/**
 * The other half of `data`'s `private: true`: the bytes are still the owner's to read, one
 * row at a time, when a photo is actually opened.
 */
describe('media:item — one row, bytes and all (MICA-110)', () => {
  it('rejects an id that is not a positive integer', async () => {
    const reply = await callItem({ id: 0 });

    expect(reply.error).toMatch(/id/);
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('scopes the read by citizenid, so an id alone is never authorization', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);

    await callItem({ id: 42 });

    const [sql, params] = dbMock.single.mock.calls[0];
    expect(sql as string).toContain('`citizenid` = ?');
    expect(params as unknown[]).toContain('CID_A');
  });

  it('refuses a row the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await callItem({ id: 42 });

    expect(reply.error).toMatch(/could not be found/);
  });

  it.each(['moderated', 'deleted'])(
    'refuses a %s row, which the owner can still find by id',
    async (status) => {
      // The same hole `drop` closes: `findById` scopes by owner but knows nothing about
      // this table's moderation state, so without the explicit check a photo pulled from
      // every list stays readable in full to anyone who saw its id.
      dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status });

      const reply = await callItem({ id: 42 });

      expect(reply.error).toMatch(/could not be found/);
    }
  );

  it('answers a missing row and somebody else’s row with the same sentence', async () => {
    dbMock.single.mockResolvedValueOnce(null);
    const missing = (await callItem({ id: 1 })).error;
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status: 'moderated' });
    const notYours = (await callItem({ id: 2 })).error;

    // Distinguishing them would answer "does this id exist" for ids the caller does not own.
    expect(missing).toBe(notYours);
  });

  it('returns the full row, bytes included', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);

    const reply = await callItem({ id: 42 });

    expect(reply).toMatchObject({ id: 42, kind: 'photo', data: 'base64-bytes' });
  });

  it('coerces a Buffer payload to a string, as the list read does', async () => {
    // A `mediumtext` can arrive as a Buffer depending on the driver, which would cross NUI
    // as `{type:'Buffer',data:[...]}` and render as nothing.
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, data: Buffer.from('bytes', 'utf8') });

    const reply = await callItem({ id: 42 });

    expect(reply.data).toBe('bytes');
  });
});

/**
 * Store-back, which is **not** the cancelled backfill.
 *
 * The cancelled thing was a migration writing thumbnails onto legacy photos, dropped
 * because a wiped test server will have none. This is how a thumbnail reaches the column at
 * all after the fact, and it is needed indefinitely: `AddMedia` (`lib/publicApi.ts`) is a
 * published export whose `thumbnail` is optional, so other resources keep creating
 * thumbnail-less rows. Without this each one is re-fetched at full size on every gallery
 * open, forever.
 *
 * The server cannot generate one itself — no canvas in the FiveM server runtime, and an
 * image codec would be a runtime dependency shipped to every owner (§2.5) that cannot even
 * decode the WebP this codebase produces.
 */
describe('media:thumbnail — storing a thumbnail a client generated', () => {
  it('rejects an id that is not a positive integer', async () => {
    const reply = await callThumbnail({ id: -1, thumbnail: TINY_STILL });

    expect(reply.error).toMatch(/id/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a script data URI', 'data:text/html,<script>alert(1)</script>'],
    ['a bare string', 'not-a-uri'],
    ['a number', 12],
    ['nothing at all', undefined]
  ])('refuses %s', async (_label, thumbnail) => {
    const reply = await callThumbnail({ id: 42, thumbnail });

    expect(reply.error).toMatch(/thumbnail/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('refuses a remote URL, though AddMedia accepts one for a hotlinked poster', async () => {
    // Deliberately narrower than publicApi's SAFE_URL. This action exists for a client
    // persisting bytes it encoded locally, so a remote URL is never the honest answer —
    // and storing one points a gallery tile at a third-party host the phone then requests
    // on every render, which is a beacon rather than a thumbnail.
    const reply = await callThumbnail({ id: 42, thumbnail: 'https://x.test/tracker.png' });

    expect(reply.error).toMatch(/thumbnail/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('refuses one too large to be a thumbnail', async () => {
    // Without a cap, store-back is a second way to store a full-size photo — the problem
    // this ticket exists to remove, arriving through the door built to close it.
    const oversize = `data:image/png;base64,${'A'.repeat(64 * 1024)}`;

    const reply = await callThumbnail({ id: 42, thumbnail: oversize });

    expect(reply.error).toMatch(/thumbnail/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('writes only the caller’s own active row, and only while it has none', async () => {
    dbMock.update.mockResolvedValueOnce(true);

    const reply = await callThumbnail({ id: 42, thumbnail: TINY_STILL });

    const [sql, params] = dbMock.update.mock.calls[0];
    expect(sql as string).toContain('`citizenid` = ?');
    expect(sql as string).toContain("`status` = 'active'");
    // Write-once. Without it the one door to a `clientWritable: false` column is also a way
    // to rewrite it repeatedly.
    expect(sql as string).toContain('`thumbnail` IS NULL');
    expect(params as unknown[]).toEqual([TINY_STILL, 42, 'CID_A']);
    expect(reply).toEqual({ stored: true });
  });

  it('never lets the payload name the column it writes', async () => {
    // `storeThumbnail` names its own columns, so these were inert before the contract; now
    // the request carrying them is refused outright, which is the stronger promise.
    const reply = await callThumbnail({
      id: 42,
      thumbnail: TINY_STILL,
      data: 'smuggled',
      citizenid: 'CID_B'
    });

    expect(reply.error).toMatch(/data/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('reports a row that already had one as not stored, rather than as an error', async () => {
    // Two tiles, two sessions and the same photo race by nature; "somebody got there first"
    // is a normal outcome rather than a failure a player should see.
    dbMock.update.mockResolvedValueOnce(false);

    const reply = await callThumbnail({ id: 42, thumbnail: TINY_STILL });

    expect(reply).toEqual({ stored: false });
    expect(reply.error).toBeUndefined();
  });
});

/**
 * MICA-116. `data` is `mediumtext`, and that was the only bound `assertWritableValue`
 * had to check a photo against — 16,777,215 characters, sixty times a minute per player
 * under the default `gphone_rate_limit`, into a table with no retention. `thumbnail` next
 * door has had an explicit cap for exactly this reason; the column holding the megabytes
 * had none.
 *
 * The number is sized from the capture path — 1080 on the longer edge, one lossy encode at
 * `gphone_camera_quality`, base64 — and never from what the column tolerates.
 */
describe('media:create — the size a photo may actually be (MICA-116)', () => {
  const MAX_DATA_LENGTH = 4 * 1024 * 1024;
  const photoOf = (bytes: number) => `data:image/webp;base64,${'A'.repeat(bytes)}`;

  it('accepts an ordinary capture', async () => {
    // A few hundred kilobytes is what a real photo measures — the size MICA-110 found
    // the gallery downloading per tile.
    const reply = await callCreate({ kind: 'photo', data: photoOf(400 * 1024) });

    expect(reply.error).toBeUndefined();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('still accepts one several times larger than the camera has ever produced', async () => {
    // The cap is a backstop, not a compression target: it must never refuse a real photo
    // taken on a server that set `gphone_camera_quality 100`.
    const reply = await callCreate({ kind: 'photo', data: photoOf(3 * 1024 * 1024) });

    expect(reply.error).toBeUndefined();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('refuses a payload larger than the capture path could produce', async () => {
    const reply = await callCreate({ kind: 'photo', data: photoOf(MAX_DATA_LENGTH) });

    expect(reply.error).toMatch(/too large/i);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses one the column would happily have taken', async () => {
    // The exact hole: `mediumtext` holds 16MB, so this row was written and reported as a
    // success before the cap existed.
    const reply = await callCreate({ kind: 'photo', data: 'A'.repeat(12 * 1024 * 1024) });

    expect(reply.error).toMatch(/too large/i);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('tells the player something a player can read', async () => {
    // §2.9: this message reaches a toast, so no `[Repository]` prefix and no table name.
    const reply = await callCreate({ kind: 'photo', data: photoOf(MAX_DATA_LENGTH) });

    expect(reply.error).not.toContain('[Repository]');
    expect(reply.error).not.toContain('gphone_media');
  });

  it('bounds what a payload may set, not what the table may hold', async () => {
    // A row an external resource added through `AddMedia` — a voice clip, a video poster —
    // is not a client payload and is not held to the camera's number, so a drop must still
    // copy it. The cap belongs to the write boundary.
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, data: 'A'.repeat(8 * 1024 * 1024) });
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    const reply = await callDrop({ mediaId: 42 });

    expect(reply).toEqual({ count: 1 });
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });
});

/**
 * MICA-75. Not to be confused with `drop` above, which shares a copy to nearby phones
 * and never touches this row's own `status`. See `Repository.test.ts` for the mechanics
 * `restore` itself is built on.
 */
describe('media:restore (MICA-75)', () => {
  it('restores deleted media within the window, scoped to the caller citizenid', async () => {
    dbMock.update.mockResolvedValue(true);

    const reply = await callRestore({ id: 12 });

    expect(reply).toEqual({ ok: true });
    const [sql, params] = dbMock.update.mock.calls[0];
    expect(String(sql)).toContain('UPDATE `gphone_media`');
    expect(params).toEqual([12, 'CID_A', 30]);
  });

  it('reports false once the window has passed, rather than throwing', async () => {
    dbMock.update.mockResolvedValue(false);

    const reply = await callRestore({ id: 12 });

    expect(reply).toEqual({ ok: false });
  });

  it('refuses a payload naming a citizenid, rather than quietly ignoring it', async () => {
    dbMock.update.mockResolvedValue(true);

    const reply = await callRestore({ id: 12, citizenid: 'CID_VICTIM' });

    // The predicate was always the caller's own citizenid. What changed is that a payload
    // asking for somebody else's is now an error rather than a no-op — a hostile key has no
    // slot, so the request that carried it does not half-succeed.
    expect(reply.error).toMatch(/citizenid/);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('rejects a missing id before touching the database', async () => {
    const reply = await callRestore({});

    expect(reply).toMatchObject({ error: expect.any(String) });
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

/**
 * MICA-75-wiring: the "Recently Deleted" list itself. `status` is never
 * client-filterable, so this reads `Repository.findDeleted` through a named action rather
 * than the generic `get` — and, unlike Contacts and Notes, projects the columns down the
 * same way `get` already does (MICA-110): a deleted row can still carry the full base64
 * `data` blob, which a list needing only a caption and a small still has no business
 * paying for.
 */
describe('media:getDeleted (MICA-75-wiring)', () => {
  const GET_DELETED_EVENT = 'gphone:server:media:getDeleted';
  const callGetDeleted = (data: unknown) => call(GET_DELETED_EVENT, data);

  it('reads only the caller’s own deleted rows, bounded to the restore window', async () => {
    dbMock.query.mockResolvedValue([{ id: 12, citizenid: 'CID_A', status: 'deleted' }]);

    const reply = await callGetDeleted({});

    expect(reply).toEqual([{ id: 12, citizenid: 'CID_A', status: 'deleted' }]);
    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('FROM `gphone_media`');
    expect(String(sql)).toContain("`status` = 'deleted'");
    expect(params).toEqual(['CID_A', 30]);
  });

  it('projects the columns down — no `data` blob in a list read', async () => {
    dbMock.query.mockResolvedValue([]);

    await callGetDeleted({});

    const [sql] = dbMock.query.mock.calls[0];
    expect(String(sql)).not.toContain('`data`');
    expect(String(sql)).toContain('`thumbnail`');
  });

  it('refuses a payload claiming a citizenid — the list takes no payload at all', async () => {
    dbMock.query.mockResolvedValue([]);

    const reply = await callGetDeleted({ citizenid: 'CID_VICTIM' });

    expect(reply.error).toMatch(/payload/);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('is registered alongside restore', () => {
    expect(handlers.has(GET_DELETED_EVENT)).toBe(true);
  });
});
