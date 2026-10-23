// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-428: a hosted photo is never deleted from its host. Nothing deletes a `mica_media` row
 * any more — retention expires it, a purge or the orphan sweep erases it — and its file is kept
 * with it, for evidence. Before, MICA-243 and MICA-292 released the file through
 * `mica_media_delete_url` from every one of those paths.
 *
 * So each path is driven with a delete URL configured, and asked two things: that the rows were
 * moved by a status change, and that nothing went to the host at all. `fetch` is the only way
 * this server reaches the host, so a spy on it that is never called is the proof.
 *
 * `Database` is mocked, so the SQL is inspected, never run; `pnpm test:migrations` and
 * `pnpm test:schema` run these paths against MariaDB.
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
  recordedImageHosts,
  rememberImageHost,
  resetMediaHostForTests,
  uploadImage,
  warnRetiredDeleteUrl
} from '../lib/mediaHost';
import { purgeOwnedRows, sweepOrphanedRows } from '../lib/orphanSweep';
import { resetRetentionForTests } from '../lib/contentRetention';
import { pruneExpiredMedia, purgeMediaForCitizen } from '../services/Media';
import '../services/index';

const SHELL_CHARACTER_DELETED = 'mica:server:shell:characterDeleted';
const MEDIA_CHARACTER_DELETED = 'mica:server:media:characterDeleted';

const withConvars = (values: Record<string, string>) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in values ? values[name] : fallback;
};

/** Hosting configured, the retired delete URL included: it must do nothing. */
const hosting = (extra: Record<string, string> = {}) =>
  withConvars({
    mica_media_upload_url: 'https://api.example.test/upload',
    mica_media_image_host: 'img.example.test',
    mica_media_delete_url: 'https://api.example.test/files/{name}',
    mica_media_retention: '1',
    ...extra
  });

let fetchMock: ReturnType<typeof vi.fn>;

const statements = (): string[] =>
  dbMock.query.mock.calls.map((call: any[]) => String(call[0]).replace(/\s+/g, ' '));
const mediaErase = (sql: string) =>
  sql.startsWith('UPDATE `mica_media` SET `status` = ?, `updated_at` = `updated_at` WHERE');

/** Every string console.* was handed. */
const logged = (): string =>
  [console.log, console.warn, console.error]
    .flatMap((fn) => (fn as any).mock.calls.flat())
    .map(String)
    .join('\n');

/**
 * A database with media rows to move: an erase moves two and then none, a retention select
 * serves two ids, an owner table that answers, and a grace long over.
 */
const database = () => {
  const erased = new Map<string, number>();
  dbMock.single.mockImplementation(async (sql: string) => {
    if (sql.includes('AS total')) return { total: 120 };
    if (sql.includes('AS matched')) return { matched: 3 };
    if (sql.includes('AS collation')) {
      return { collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4' };
    }
    throw new Error(`unexpected single(): ${sql}`);
  });
  dbMock.scalar.mockResolvedValue(0);
  dbMock.query.mockImplementation(async (raw: string, params: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ');
    if (sql.includes('information_schema')) return [{ n: 1 }];
    if (sql.startsWith('SELECT m.`id` AS `id`, TIMESTAMPDIFF')) {
      return [{ id: 'retention:mica_media:1d', age: 3 * 24 * 60 * 60 }];
    }
    if (sql.startsWith('SELECT t.`id` FROM `mica_media` t')) return [{ id: 1 }, { id: 2 }];
    if (sql.startsWith('SELECT DISTINCT')) return [{ owner: 'CID_A' }];
    if (sql.startsWith('UPDATE `mica_media`')) {
      // Each erase statement moves its rows once; the loop stops on the next.
      const key = `${sql}|${JSON.stringify(params.slice(1))}`;
      const moved = erased.has(key) ? 0 : 2;
      erased.set(key, moved);
      return { affectedRows: moved };
    }
    if (sql.startsWith('UPDATE')) return { affectedRows: 0 };
    return [];
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockReset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  hosting();
  resetMediaHostForTests();
  resetRetentionForTests();
  database();
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

describe('no path deletes a hosted file (MICA-428)', () => {
  it("a deleted character's purge erases the media rows and asks the host for nothing", async () => {
    const { erased, failures } = await purgeOwnedRows('CID_Z');

    expect(failures).toEqual([]);
    expect(erased).toBeGreaterThan(0);
    const erase = dbMock.query.mock.calls.find(([sql]) =>
      mediaErase(String(sql).replace(/\s+/g, ' '))
    )!;
    expect(erase[1]).toEqual(['erased', 'CID_Z', 'erased']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nor does the hook that runs it', async () => {
    localHandlers.get(SHELL_CHARACTER_DELETED)![0]('CID_Z');
    await vi.waitFor(() => expect(logged()).toMatch(/erased \d+ row\(s\) for deleted character/));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nor the media-only purge, or its hook', async () => {
    expect(await purgeMediaForCitizen('CID_Z')).toBe(2);
    localHandlers.get(MEDIA_CHARACTER_DELETED)![0]('CID_Y');
    await vi.waitFor(() =>
      expect(logged()).toMatch(/\[micamedia\] erased \d+ row\(s\) for deleted character/)
    );
    expect(statements().some(mediaErase)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nor the orphan sweep', async () => {
    const result = await sweepOrphanedRows({
      only: [{ table: 'mica_media', column: 'citizenid' }],
      label: 'micamedia'
    });

    expect(result.skipped).toBeNull();
    expect(result.erased).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nor the retention prune, which expires the rows instead', async () => {
    expect(await pruneExpiredMedia()).toBe(2);

    const expire = dbMock.query.mock.calls.find(([sql]) =>
      String(sql).startsWith('UPDATE `mica_media` SET `status` = ?')
    )!;
    expect(expire[1].slice(0, 3)).toEqual(['expired', 1, 2]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('and nothing anywhere sends an HTTP DELETE, or a DELETE statement', async () => {
    await purgeOwnedRows('CID_Z');
    await pruneExpiredMedia();
    await sweepOrphanedRows();

    expect(statements().some((sql) => /\bDELETE\b/.test(sql))).toBe(false);
    for (const [, init] of fetchMock.mock.calls) expect(init?.method).not.toBe('DELETE');
  });
});

describe('the retired delete URL', () => {
  it('is said once at start when an owner still sets it, and does nothing', () => {
    warnRetiredDeleteUrl();
    warnRetiredDeleteUrl();

    const lines = (console.warn as any).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.filter((l: string) => l.includes('mica_media_delete_url'))).toEqual([
      '[micamedia] mica_media_delete_url is set but no longer used: micaOS keeps every hosted ' +
        'photo for as long as its row, which is for good (MICA-428). Nothing is deleted from ' +
        'the image host.'
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says nothing when it is unset — the positive twin', () => {
    hosting({ mica_media_delete_url: '' });
    warnRetiredDeleteUrl();
    expect(console.warn).not.toHaveBeenCalled();
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

  it('keeps a host this process remembered when the ledger cannot be written', async () => {
    dbMock.query.mockRejectedValue(new Error('no ledger'));
    await rememberImageHost('old.example.test');

    expect([...(await recordedImageHosts())]).toContain('old.example.test');
    expect(logged()).toMatch(/run micaschema apply/);
  });

  it('refuses to record something that is not a plain host name', async () => {
    await rememberImageHost('evil.test/path');
    await rememberImageHost(null);

    expect(dbMock.query).not.toHaveBeenCalled();
  });
});
