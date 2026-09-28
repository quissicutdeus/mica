// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-292: every path that deletes hosted photo rows releases their files.
 *
 * MICA-243 wired retention and the media-only purge. Three other deletes skipped it — the
 * whole-phone `shell:characterDeleted` purge, the orphan sweep, and the `ON DELETE CASCADE`
 * from `players` — so a deleted character's photos stayed publicly reachable at their URLs.
 * And the release filtered by the host configured **now**, so after an owner changed it the
 * old host's photos were neither released nor counted.
 *
 * What each block is careful to prove:
 *
 * - **Order, not just occurrence.** The URLs have to be read before the rows go, so the
 *   collect is asserted to come before the `DELETE`, and the reference check after it.
 * - **A file another player's copy still names is never requested**, on every new path —
 *   that is the failure that costs somebody a photo rather than storage.
 * - **A former host's file is counted and never requested**: the delete URL configured now
 *   is the current host's, and the log names the host and a count, never a URL.
 *
 * `Database` is mocked, so the SQL is inspected, never run; `pnpm test:migrations` runs the
 * orphan sweep and the purge against MariaDB with these statements in them.
 */
const { dbMock, localHandlers } = vi.hoisted(() => {
  const local = new Map<string, Function[]>();
  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    local.set(event, [...(local.get(event) ?? []), handler]);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    localHandlers: local
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { __setResourceLookup } from '../lib/FrameworkBridge';
import {
  releaseHostedImages,
  rememberImageHost,
  reportRelease,
  resetMediaHostForTests,
  uploadImage,
  warnIfCascadeHidesHostedPhotos
} from '../lib/mediaHost';
import { purgeOwnedRows, sweepOrphanedRows } from '../lib/orphanSweep';
import { resetRetentionForTests } from '../lib/contentRetention';
import { pruneExpiredMedia, purgeMediaForCitizen } from '../services/Media';
import '../services/index';

const SHELL_CHARACTER_DELETED = 'mica:server:shell:characterDeleted';

/** On the current host, owned only by the deleted character. */
const MINE = 'https://img.example.test/p/mine.webp';
/** On the current host, and a proximity copy on another player's row still names it. */
const SHARED = 'https://img.example.test/p/shared.webp';
/** On the host the owner used before `img.example.test`. */
const OLD = 'https://old.example.test/p/old.webp';
/** A hotlink `AddMedia` stored: not ours, never counted. */
const GIF = 'https://giphy.test/a.gif';

const DELETE_TEMPLATE = 'https://api.example.test/files/{name}';

const withConvars = (values: Record<string, string>) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in values ? values[name] : fallback;
};

const hosting = (extra: Record<string, string> = {}) =>
  withConvars({
    mica_media_upload_url: 'https://api.example.test/upload',
    mica_media_image_host: 'img.example.test',
    mica_media_delete_url: DELETE_TEMPLATE,
    ...extra
  });

let fetchMock: ReturnType<typeof vi.fn>;

const statements = (): string[] => dbMock.query.mock.calls.map((call: any[]) => String(call[0]));
const isCollect = (sql: string) => sql.startsWith('SELECT DISTINCT t.`url` FROM `mica_media` t');
const isReferenceCheck = (sql: string) =>
  sql.startsWith('SELECT DISTINCT `url` FROM `mica_media` WHERE `url` IN');
const isLedgerRead = (sql: string) => sql.startsWith('SELECT `id` FROM `mica_schema_migrations`');

/** Every string console.* was handed. */
const logged = (): string =>
  [console.log, console.warn, console.error]
    .flatMap((fn) => (fn as any).mock.calls.flat())
    .map(String)
    .join('\n');

/** One of the deleted character's media rows; `reported` is an open report naming it. */
interface Row {
  url: string;
  reported?: boolean;
}

/** Whether a statement carries retention's open-report hold on the row (MICA-167). */
const holdsReports = (sql: string) =>
  sql.includes('FROM `mica_reports` r WHERE r.`target_table` = ?') &&
  sql.includes("r.`status` = 'active' AND r.`resolution` = 'pending'");

/**
 * A database holding the deleted character's media `rows`, which the collect and the delete
 * act on as MariaDB would: a statement carrying the open-report hold skips a reported row,
 * one without it takes every row. The delete removes what it matched, so the reference check
 * afterwards sees what survived. `SHARED` is also on another player's row throughout, and the
 * ledger has recorded `old.example.test` as an image host. Answers the live rows.
 */
const mediaRows = (input: (string | Row)[], options: { collectFails?: boolean } = {}) => {
  const rows: Row[] = input.map((r) => (typeof r === 'string' ? { url: r } : r));
  const matched = (sql: string) => rows.filter((r) => !(r.reported && holdsReports(sql)));
  dbMock.single.mockImplementation(async (sql: string) => {
    if (sql.includes('AS total')) return { total: 120 };
    if (sql.includes('AS matched')) return { matched: 3 };
    throw new Error(`unexpected single(): ${sql}`);
  });
  dbMock.scalar.mockResolvedValue(null);
  dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (isCollect(sql)) {
      if (options.collectFails) throw new Error('collect failed');
      return matched(sql).map(({ url }) => ({ url }));
    }
    if (isReferenceCheck(sql)) {
      const live = new Set([SHARED, ...rows.map((r) => r.url)]);
      return params.filter((url) => live.has(url as string)).map((url) => ({ url }));
    }
    if (isLedgerRead(sql)) return [{ id: 'mediahost:old.example.test' }];
    if (sql.startsWith('SELECT DISTINCT')) return [{ owner: 'CID_A' }];
    if (sql.startsWith('DELETE FROM mica_media')) {
      const gone = matched(sql);
      for (const row of gone) rows.splice(rows.indexOf(row), 1);
      return { affectedRows: gone.length };
    }
    if (sql.trimStart().startsWith('DELETE')) return { affectedRows: 1 };
    return [];
  });
  return rows;
};

const isMediaPurge = (sql: string) => sql.startsWith('DELETE FROM mica_media WHERE citizenid = ?');

const requested = (): string[] => fetchMock.mock.calls.map((call: any[]) => String(call[0]));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockReset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  hosting();
  resetMediaHostForTests();
  resetRetentionForTests();
  // qbx_core, so the orphan sweep has an owner table to ask.
  __setResourceLookup((name) => (name === 'qbx_core' ? { GetPlayer: () => null } : undefined));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setResourceLookup();
  vi.unstubAllGlobals();
});

describe('shell:characterDeleted releases the character’s hosted photos', () => {
  it('reads the URLs before deleting the rows, and releases after', async () => {
    mediaRows([MINE]);

    await purgeOwnedRows('CID_Z');

    const all = statements();
    const collect = all.findIndex(isCollect);
    const remove = all.findIndex(isMediaPurge);
    const check = all.findIndex(isReferenceCheck);
    expect(collect).toBeGreaterThanOrEqual(0);
    expect(collect).toBeLessThan(remove);
    expect(remove).toBeLessThan(check);
    expect(dbMock.query.mock.calls[collect][1]).toEqual(['CID_Z', 'mica_media']);
    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('never requests a file another player’s copy still names', async () => {
    mediaRows([MINE, SHARED]);

    await purgeOwnedRows('CID_Z');

    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('is what the registered hook runs', async () => {
    mediaRows([MINE]);

    localHandlers.get(SHELL_CHARACTER_DELETED)![0]('CID_Z');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('leaves the media rows alone when it cannot read what they name', async () => {
    mediaRows([MINE], { collectFails: true });

    const { failures } = await purgeOwnedRows('CID_Z');

    expect(failures.map((f) => f.table)).toContain('mica_media');
    expect(statements().some(isMediaPurge)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the orphan sweep releases what the swept rows named', () => {
  it('reads the orphans’ URLs with the sweep’s own predicate, before the delete', async () => {
    mediaRows([MINE, SHARED]);

    const result = await sweepOrphanedRows();

    expect(result.skipped).toBeNull();
    const all = statements();
    const collect = all.findIndex(isCollect);
    const remove = all.findIndex((sql) =>
      sql.startsWith('DELETE FROM mica_media WHERE NOT EXISTS')
    );
    expect(collect).toBeGreaterThanOrEqual(0);
    expect(collect).toBeLessThan(remove);
    expect(all[collect]).toContain(
      'NOT EXISTS (SELECT 1 FROM players p WHERE p.citizenid = t.citizenid)'
    );
    // Only the file nothing else names.
    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('releases through the media-only sweep too', async () => {
    const { pruneOrphanedMedia } = await import('../services/Media');
    mediaRows([MINE]);

    await pruneOrphanedMedia();

    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('skips the media table, and deletes nothing from it, when the collect fails', async () => {
    mediaRows([MINE], { collectFails: true });

    const result = await sweepOrphanedRows();

    expect(result.failures.map((f) => f.table)).toContain('mica_media');
    expect(statements().some((sql) => sql.startsWith('DELETE FROM mica_media'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Review of MICA-292: once the purge and the sweep delete the hosted file, a player under an
 * open report could delete their character and destroy the reported photo. Retention never
 * could (MICA-167); these now hold the same rows by the same predicate.
 */
describe('a photo under an open report is kept as evidence', () => {
  const EVIDENCE = 'https://img.example.test/p/evidence.webp';
  const EVIDENCE_DELETE = 'https://api.example.test/files/evidence.webp';

  it('survives shell:characterDeleted, row and file, while the rest go', async () => {
    const rows = mediaRows([MINE, { url: EVIDENCE, reported: true }]);

    await purgeOwnedRows('CID_Z');

    expect(rows.map((r) => r.url)).toEqual([EVIDENCE]);
    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('survives the media-only purge too', async () => {
    const rows = mediaRows([MINE, { url: EVIDENCE, reported: true }]);

    await purgeMediaForCitizen('CID_Z');

    expect(rows.map((r) => r.url)).toEqual([EVIDENCE]);
    expect(requested()).not.toContain(EVIDENCE_DELETE);
  });

  it('survives the orphan sweep', async () => {
    const rows = mediaRows([MINE, { url: EVIDENCE, reported: true }]);

    await sweepOrphanedRows();

    expect(rows.map((r) => r.url)).toEqual([EVIDENCE]);
    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('is released by the next orphan sweep once the report resolves', async () => {
    const rows = mediaRows([{ url: EVIDENCE, reported: true }]);
    await purgeOwnedRows('CID_Z');
    expect(requested()).toEqual([]);

    // The report is resolved. The character is already gone, so the row is an orphan now.
    rows[0].reported = false;
    await sweepOrphanedRows();

    expect(rows).toEqual([]);
    expect(requested()).toEqual([EVIDENCE_DELETE]);
  });
});

describe('a photo on a former image host', () => {
  it('is counted by host and never requested', async () => {
    mediaRows([]);

    const outcome = await releaseHostedImages([OLD, GIF, MINE]);

    expect(outcome.formerHost).toEqual({ 'old.example.test': 1 });
    expect(outcome.deleted).toBe(1);
    // Never the old host's file, through the current host's delete URL or any other.
    expect(requested()).toEqual(['https://api.example.test/files/mine.webp']);
  });

  it('is not counted while a row still names it', async () => {
    mediaRows([]);
    dbMock.query.mockImplementation(async (sql: string) => {
      if (isLedgerRead(sql)) return [{ id: 'mediahost:old.example.test' }];
      if (isReferenceCheck(sql)) return [{ url: OLD }];
      return [];
    });

    expect((await releaseHostedImages([OLD])).formerHost).toEqual({});
  });

  it('is counted even with no image host configured at all any more', async () => {
    withConvars({});
    mediaRows([]);

    expect((await releaseHostedImages([OLD])).formerHost).toEqual({ 'old.example.test': 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is logged with its host and count, and never its URL', () => {
    reportRelease('micamedia', {
      deleted: 0,
      failed: 0,
      unconfigured: 0,
      formerHost: { 'old.example.test': 2 }
    });

    expect(logged()).toMatch(/2 hosted photo\(s\) on old\.example\.test, a former image host/);
    expect(logged()).not.toContain(OLD);
  });

  it('a hotlink on an unrecorded host is neither counted nor requested', async () => {
    mediaRows([]);

    const outcome = await releaseHostedImages([GIF]);

    expect(outcome).toEqual({ deleted: 0, failed: 0, unconfigured: 0, formerHost: {} });
    expect(statements().some(isReferenceCheck)).toBe(false);
  });

  it('is counted when retention prunes its row, which it was not before', async () => {
    hosting({ mica_media_retention: '30' });
    let served = false;
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.')) return [{ n: 1 }];
      if (sql.startsWith('SELECT `id`, TIMESTAMPDIFF')) {
        return [{ id: 'retention:mica_media:30d', age: 2 * 24 * 60 * 60 }];
      }
      if (sql.startsWith('SELECT t.`id` FROM `mica_media`')) {
        if (served) return [];
        served = true;
        return [{ id: 1 }];
      }
      if (isCollect(sql)) return [{ url: OLD }];
      if (isLedgerRead(sql)) return [{ id: 'mediahost:old.example.test' }];
      if (sql.startsWith('DELETE FROM `mica_media`')) return { affectedRows: 1 };
      return [];
    });

    expect(await pruneExpiredMedia()).toBe(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toMatch(/1 hosted photo\(s\) on old\.example\.test, a former image host/);
  });

  it('is counted by the media-only purge as well', async () => {
    mediaRows([OLD]);

    await purgeMediaForCitizen('CID_Z');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toMatch(/on old\.example\.test, a former image host/);
  });
});

describe('recording which hosts were image hosts', () => {
  it('writes the host to the ledger once per process', async () => {
    dbMock.query.mockResolvedValue({ affectedRows: 1 });

    await rememberImageHost('img.example.test');
    await rememberImageHost('img.example.test');

    const writes = dbMock.query.mock.calls.filter((call: any[]) =>
      String(call[0]).startsWith('INSERT IGNORE INTO `mica_schema_migrations`')
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual(['mediahost:img.example.test']);
  });

  it('records the host a photo was just uploaded to', async () => {
    dbMock.query.mockResolvedValue({ affectedRows: 1 });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://img.example.test/p/new.webp' })
    });

    await uploadImage(`data:image/webp;base64,${btoa('x')}`);

    expect(dbMock.query.mock.calls.map((call: any[]) => call[1])).toContainEqual([
      'mediahost:img.example.test'
    ]);
  });

  it('considers a host this process remembered when the ledger cannot be written', async () => {
    dbMock.query.mockRejectedValue(new Error('no ledger'));
    await rememberImageHost('old.example.test');
    withConvars({ mica_media_image_host: 'img.example.test' });

    const outcome = await releaseHostedImages([OLD]);

    // The reference check failed too, so it is reported as failed rather than guessed at.
    expect(outcome.failed).toBe(1);
    expect(logged()).toMatch(/run micaschema apply/);
  });

  it('refuses to record something that is not a plain host name', async () => {
    await rememberImageHost('evil.test/path');
    await rememberImageHost(null);

    expect(dbMock.query).not.toHaveBeenCalled();
  });
});

describe('the cascade micaOS cannot see', () => {
  it('warns at start when mica_media cascades and there is an image host', async () => {
    dbMock.query.mockResolvedValue([{ n: 1 }]);

    expect(await warnIfCascadeHidesHostedPhotos('mica_media')).toBe(true);

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('information_schema.REFERENTIAL_CONSTRAINTS');
    expect(String(sql)).toContain("`DELETE_RULE` = 'CASCADE'");
    expect(params).toEqual(['mica_media']);
    expect(logged()).toMatch(/ON DELETE CASCADE/);
    expect(logged()).toContain(SHELL_CHARACTER_DELETED);
  });

  it('is quiet without a cascade', async () => {
    dbMock.query.mockResolvedValue([{ n: 0 }]);

    expect(await warnIfCascadeHidesHostedPhotos('mica_media')).toBe(false);
    expect(logged()).toBe('');
  });

  it('asks nothing when no image host is configured', async () => {
    withConvars({});

    expect(await warnIfCascadeHidesHostedPhotos('mica_media')).toBe(false);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('says it could not check, rather than reading a failure as no cascade', async () => {
    dbMock.query.mockRejectedValue(new Error('denied'));

    expect(await warnIfCascadeHidesHostedPhotos('mica_media')).toBe(false);
    expect(logged()).toMatch(/could not check whether mica_media cascades/);
  });
});
