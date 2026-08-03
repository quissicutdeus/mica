import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { resolveAppSchema, buildRepository } from '../lib/defineService';
import { allow, forgetSource, __setRateLimitClock, __resetRateLimits } from '../lib/rateLimit';

/**
 * Abuse controls at the one chokepoint every app already passes through.
 *
 * These were absent entirely: the endpoint authenticated the caller, reduced the payload to an
 * allowlist, and then answered as many requests of any size as arrived. That was survivable
 * while every read carried an ownership predicate and every write landed in the caller's own
 * rows — the blast radius of a flood was the flooder. Public reads and member-scoped writes
 * ended that, which is why this lands directly behind them.
 */

describe('column limits — derived from the declaration, not invented', () => {
  it('rejects a string longer than the declared length', () => {
    // `length: 50` reached the DDL and stopped there. MySQL in non-strict mode then
    // **silently truncates**: row written, write reports success, data quietly wrong.
    const repo = buildRepository(
      resolveAppSchema({ id: 'short', schema: { name: { type: 'string', length: 50 } } })
    );

    expect(() => repo.assertWritableValue('name', 'x'.repeat(51))).toThrow(
      /limited to 50 characters/
    );
    expect(() => repo.assertWritableValue('name', 'x'.repeat(50))).not.toThrow();
  });

  it('defaults a string with no declared length to 255, matching the DDL', () => {
    const repo = buildRepository(resolveAppSchema({ id: 'plain', schema: { name: 'string' } }));

    expect(() => repo.assertWritableValue('name', 'x'.repeat(256))).toThrow(
      /limited to 255 characters/
    );
  });

  it('lets a mediumtext column hold a base64 screenshot', () => {
    // The reason the cap is per column rather than one number for the whole payload:
    // `photos.image` is mediumtext and legitimately carries an image.
    const repo = buildRepository(
      resolveAppSchema({ id: 'shots', schema: { image: { type: 'mediumtext', notNull: true } } })
    );

    expect(() => repo.assertWritableValue('image', 'A'.repeat(2_000_000))).not.toThrow();
    expect(() => repo.assertWritableValue('image', 'A'.repeat(16_777_216))).toThrow(/limited to/);
  });

  it('rejects an enum value the column does not permit', () => {
    const repo = buildRepository(
      resolveAppSchema({
        id: 'listings',
        schema: { condition: { type: 'enum', values: ['new', 'used'] } }
      })
    );

    expect(() => repo.assertWritableValue('condition', 'stolen')).toThrow(/must be one of/);
    expect(() => repo.assertWritableValue('condition', 'used')).not.toThrow();
  });

  it('rejects a fractional value for an int column', () => {
    const repo = buildRepository(resolveAppSchema({ id: 'counts', schema: { qty: 'int' } }));

    expect(() => repo.assertWritableValue('qty', 1.5)).toThrow(/whole number/);
    expect(() => repo.assertWritableValue('qty', 3)).not.toThrow();
  });

  it('passes null through, so clearing a nullable column still works', () => {
    const repo = buildRepository(
      resolveAppSchema({ id: 'nullable', schema: { note: { type: 'string', length: 5 } } })
    );

    expect(() => repo.assertWritableValue('note', null)).not.toThrow();
    expect(() => repo.assertWritableValue('note', undefined)).not.toThrow();
  });

  it('phrases the refusal for a player, not for a log', () => {
    // These reach a toast, not a console: ServiceEndpoint puts error.message on the wire and
    // useAppAction renders it. An ordinary long contact name gets here, so the internal
    // `[Repository]` prefix and the table name must not come with it.
    const repo = buildRepository(
      resolveAppSchema({ id: 'contacts', schema: { firstname: { type: 'string', length: 50 } } })
    );

    let message = '';
    try {
      repo.assertWritableValue('firstname', 'x'.repeat(51));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe("'firstname' is limited to 50 characters.");
    expect(message).not.toContain('[Repository]');
    expect(message).not.toContain('gphone_');
  });

  it('says nothing about a column it has no rule for', () => {
    // A hand-written repository declares `columns` but no schema, so it gets no length
    // checking. Better than inventing a limit it never declared.
    const repo = buildRepository(resolveAppSchema({ id: 'x', schema: { a: 'string' } }));

    expect(() => repo.assertWritableValue('citizenid', 'x'.repeat(9999))).not.toThrow();
  });
});

describe('rate limiting', () => {
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    __setRateLimitClock(() => clock);
    __resetRateLimits();
    (globalThis as Record<string, unknown>).GetConvar = (_n: string, fallback: string) => fallback;
  });

  afterEach(() => {
    __setRateLimitClock();
    __resetRateLimits();
  });

  it('allows up to the limit and refuses the one after', () => {
    for (let i = 0; i < 60; i++) {
      expect(allow(1, 'notes', 'create')).toBe(true);
    }
    expect(allow(1, 'notes', 'create')).toBe(false);
  });

  it('counts each action separately, so opening the phone is not a flood', () => {
    // Bootstrap preloads every app at once. Keyed per action, that is one call each rather
    // than eight against a shared budget.
    for (const service of ['notes', 'contacts', 'mail', 'photos', 'messages']) {
      for (let i = 0; i < 60; i++) {
        expect(allow(1, service, 'get')).toBe(true);
      }
    }
  });

  it('counts each player separately', () => {
    for (let i = 0; i < 61; i++) allow(1, 'notes', 'create');

    expect(allow(1, 'notes', 'create')).toBe(false);
    expect(allow(2, 'notes', 'create')).toBe(true);
  });

  it('forgives the flooder once the window has passed', () => {
    for (let i = 0; i < 61; i++) allow(1, 'notes', 'create');
    expect(allow(1, 'notes', 'create')).toBe(false);

    clock += 60_000;

    expect(allow(1, 'notes', 'create')).toBe(true);
  });

  it('honours a convar override', () => {
    (globalThis as Record<string, unknown>).GetConvar = (name: string, fallback: string) =>
      name === 'gphone_rate_limit' ? '2' : fallback;

    expect(allow(1, 'notes', 'create')).toBe(true);
    expect(allow(1, 'notes', 'create')).toBe(true);
    expect(allow(1, 'notes', 'create')).toBe(false);
  });

  it('falls back to the default for a convar that is not a positive number', () => {
    (globalThis as Record<string, unknown>).GetConvar = (name: string, fallback: string) =>
      name === 'gphone_rate_limit' ? 'off' : fallback;

    for (let i = 0; i < 60; i++) expect(allow(1, 'notes', 'create')).toBe(true);
    expect(allow(1, 'notes', 'create')).toBe(false);
  });

  it('forgets a disconnected player, so a reused source starts clean', () => {
    // FiveM reuses server ids. Without this, the next player given source 1 inherits a
    // partly-spent window and gets refused for something a previous connection did.
    for (let i = 0; i < 61; i++) allow(1, 'notes', 'create');
    expect(allow(1, 'notes', 'create')).toBe(false);

    forgetSource(1);

    expect(allow(1, 'notes', 'create')).toBe(true);
  });

  it('only forgets the source it was asked about', () => {
    for (let i = 0; i < 61; i++) allow(11, 'notes', 'create');
    for (let i = 0; i < 61; i++) allow(1, 'notes', 'create');

    // Prefix-matched keys: `1:` must not sweep `11:`.
    forgetSource(1);

    expect(allow(1, 'notes', 'create')).toBe(true);
    expect(allow(11, 'notes', 'create')).toBe(false);
  });
});

/**
 * What a public read is allowed to select.
 *
 * `citizenid` is absent from every public projection, and that is the load-bearing part.
 * A public table returns rows the reader does not own; once a player can hold several
 * accounts, the owner's citizenid correlates two deliberately-separate identities back to one
 * person — which is the entire thing an alt account exists to prevent.
 */
describe('public projection', () => {
  it('withholds citizenid from a public read', () => {
    const resolved = resolveAppSchema({
      id: 'feed',
      access: { read: 'public', write: 'owner' },
      paging: {},
      schema: { body: 'string' }
    });

    expect(resolved.publicColumns).not.toContain('citizenid');
    expect(resolved.publicColumns).toContain('body');
    expect(resolved.publicColumns).toContain('id');
  });

  it('withholds a column the schema marked private', () => {
    const resolved = resolveAppSchema({
      id: 'feed',
      access: { read: 'public', write: 'owner' },
      paging: {},
      schema: { body: 'string', draft_note: { type: 'string', private: true } }
    });

    expect(resolved.publicColumns).not.toContain('draft_note');
    expect(resolved.columns).toContain('draft_note');
  });

  it('selects the named columns rather than star, so nothing can re-add one', async () => {
    // In the projection, not by dropping keys afterwards: a repositoryFactory override that
    // re-shapes rows cannot put back a column the query never asked for.
    dbMock.query.mockReset();
    dbMock.query.mockResolvedValue([]);
    const repo = buildRepository(
      resolveAppSchema({
        id: 'feed',
        access: { read: 'public', write: 'owner' },
        paging: {},
        schema: { body: 'string' }
      })
    );

    await repo.findAll({} as never, { limit: 5 }, ['id', 'body']);

    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).toContain('SELECT `id`, `body` FROM');
    expect(sql).not.toContain('SELECT *');
    expect(sql).not.toContain('citizenid');
  });

  it('rejects a projection column the table does not have', async () => {
    // Interpolated, so it goes through the same allowlist as every other identifier (§2.9).
    const repo = buildRepository(resolveAppSchema({ id: 'feed', schema: { body: 'string' } }));

    await expect(repo.findAll({} as never, undefined, ['body', 'secret'] as never)).rejects.toThrow(
      /rejected unknown column 'secret'/
    );
  });

  it('still selects star for an owner-scoped read', async () => {
    // An owner reading their own rows has every business seeing all of them, and the unpaged
    // byte-identical guarantee depends on this staying `*`.
    dbMock.query.mockReset();
    dbMock.query.mockResolvedValue([]);
    const repo = buildRepository(resolveAppSchema({ id: 'own', schema: { body: 'string' } }));

    await repo.findAll({ citizenid: 'CIT_A' } as never);

    expect(String(dbMock.query.mock.calls[0][0])).toContain('SELECT * FROM');
  });
});
