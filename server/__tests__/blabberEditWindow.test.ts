import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Blab edit window, and the one number behind it (MICA-108).
 *
 * There used to be two: a literal `editWindow: 900` in the `defineService` declaration, which
 * is what becomes the recency predicate on the `UPDATE`, and `gphone_blabber_edit_window` read
 * separately and reported to the client so the app could hide its Edit button. The convar moved
 * the button and not the rule, so a server that raised it showed an Edit button whose save the
 * server then refused.
 *
 * These tests hold both halves to the same number, and hold the boundary itself: an edit inside
 * the window is written, one past it is refused. Server code is excluded from `tsc`, so this is
 * the only thing standing behind either (AGENTS.md §9).
 *
 * No database is involved. `dbMock.update` stands in for what MySQL does with
 * `created_at > NOW() - INTERVAL ? SECOND` — the row matches only while it is younger than the
 * window in the statement — so a change that dropped the predicate would make the "past the
 * window" assertions fail rather than quietly pass.
 */
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

const bridge = vi.hoisted(() => ({ current: 'CIT_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {}
  }
}));

const CONVAR = 'gphone_blabber_edit_window';
const MY_ACCOUNT = { id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };

/** The predicate `Repository.update` adds when the service declares an edit window. */
const WINDOW_PREDICATE = /`created_at` > NOW\(\) - INTERVAL \? SECOND/;

/**
 * Load Blabber with the convar set to `value`, or unset.
 *
 * A fresh module graph each time, because the window is resolved at declaration time — which on
 * a server is resource start. That is the whole reason a change to this convar needs a restart,
 * and the reason this helper cannot simply set a global between calls.
 */
const load = async (value?: string) => {
  vi.resetModules();
  handlers.clear();
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === CONVAR && value !== undefined ? value : fallback;
  const mod = await import('../services/Blabber');
  return mod.blabber;
};

const call = async (action: string, data: unknown, citizenid = 'CIT_A') => {
  const handler = handlers.get(`gphone:server:blabber:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = citizenid;
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls[0]?.[3];
};

/**
 * Answer an `UPDATE` the way the table would for a row posted `ageSeconds` ago.
 *
 * A statement carrying no window predicate matches regardless of age, exactly as MySQL would —
 * so removing the predicate shows up here as a late edit succeeding, not as a broken mock.
 */
const rowPostedSecondsAgo = (ageSeconds: number) => {
  dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
    if (!WINDOW_PREDICATE.test(sql)) return true;
    return ageSeconds < (params[params.length - 1] as number);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(50);
  dbMock.single.mockResolvedValue(null);
  dbMock.update.mockResolvedValue(true);
});

describe('one number governs the button and the rule', () => {
  it('defaults to fifteen minutes when the convar is unset', async () => {
    const blabber = await load();

    expect(blabber.resolved.editWindow).toBe(900);
  });

  it('takes the window from the convar, and puts that number in the UPDATE', async () => {
    const blabber = await load('300');

    expect(blabber.resolved.editWindow).toBe(300);

    await call('update', { id: 10, body: 'fixed' });

    const [sql, params] = dbMock.update.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(WINDOW_PREDICATE);
    expect(params[params.length - 1]).toBe(300);
  });

  it('reports to the client the same window it enforces', async () => {
    // The MICA-108 regression: these two came from different numbers, so raising the convar
    // offered an Edit button whose save was then refused.
    const blabber = await load('300');
    dbMock.single.mockResolvedValueOnce(MY_ACCOUNT);

    const created = await call('create', { account_id: 1, body: 'something' });

    expect(created.editWindow).toBe(300);
    expect(created.editWindow).toBe(blabber.resolved.editWindow);
  });

  it.each([
    ['not a number', 'nonsense'],
    ['zero', '0'],
    ['negative', '-5']
  ])(
    'falls back to fifteen minutes for %s rather than removing the window',
    async (_label, value) => {
      // A typo in server.cfg must not make every Blab editable forever.
      const blabber = await load(value);

      expect(blabber.resolved.editWindow).toBe(900);
    }
  );
});

describe('the boundary', () => {
  it('writes an edit made inside the window', async () => {
    await load();
    rowPostedSecondsAgo(60);

    await expect(call('update', { id: 10, body: 'fixed' })).resolves.toBe(true);
  });

  it('refuses an edit made after the window has closed', async () => {
    await load();
    rowPostedSecondsAgo(1000);

    await expect(call('update', { id: 10, body: 'too late' })).resolves.toBe(false);
  });

  it('moves the boundary with the convar, not just the button', async () => {
    await load('300');
    rowPostedSecondsAgo(200);
    await expect(call('update', { id: 10, body: 'in time' })).resolves.toBe(true);

    rowPostedSecondsAgo(400);
    await expect(call('update', { id: 10, body: 'too late' })).resolves.toBe(false);
  });

  it('still lets an author delete a post the window has frozen', async () => {
    // The window is about rewriting, not withdrawing: `delete` passes `enforceEditWindow` false
    // precisely so an expired post does not become undeletable.
    await load();
    rowPostedSecondsAgo(1000);

    await expect(call('delete', { id: 10 })).resolves.toBe(true);

    const [sql] = dbMock.update.mock.calls[0] as [string];
    expect(sql).not.toMatch(WINDOW_PREDICATE);
  });
});
