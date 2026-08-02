import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

/**
 * `refreshAdmin` asks once per session and the flag that remembers is module scope, so
 * each test needs its own copy of the module.
 *
 * Mocked with `doMock` rather than `spyOn`: `resetModules` gives the re-imported module
 * fresh copies of its own imports too, which a spy installed on the old instance never
 * reaches.
 */
const loadAdmin = async (browser: boolean, reply: () => Promise<unknown>) => {
  vi.resetModules();
  const fetchNui = vi.fn(reply);
  vi.doMock('../lib/isBrowser', () => ({ isBrowser: () => browser }));
  vi.doMock('../nui/fetchNui', () => ({ fetchNui, isBrowser: () => browser }));
  return { ...(await import('./admin')), fetchNui };
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('../lib/isBrowser'));

const grants = async () => ({ isAdmin: true });

describe('admin store', () => {
  it('stands in as allowed in a plain browser, which has no ace list to ask about', async () => {
    const { isAdmin, refreshAdmin, fetchNui } = await loadAdmin(true, grants);
    await refreshAdmin();

    expect(get(isAdmin)).toBe(true);
    expect(fetchNui).not.toHaveBeenCalled();
  });

  it('takes the server answer in game', async () => {
    const { isAdmin, refreshAdmin } = await loadAdmin(false, grants);
    await refreshAdmin();

    expect(get(isAdmin)).toBe(true);
  });

  it('is not admin unless the server says so in those exact terms', async () => {
    // Anything short of `true` is a no. A reply of the wrong shape must not read as a
    // grant: this decides whether the Administration app appears at all.
    const { isAdmin, refreshAdmin } = await loadAdmin(false, async () => ({ isAdmin: 'yes' }));
    await refreshAdmin();

    expect(get(isAdmin)).toBe(false);
  });

  it('is not admin when the request fails', async () => {
    const { isAdmin, refreshAdmin } = await loadAdmin(false, async () => {
      throw new Error('timeout');
    });
    await refreshAdmin();

    expect(get(isAdmin)).toBe(false);
  });

  it('asks once per session however many callers want the answer', async () => {
    const { refreshAdmin, fetchNui } = await loadAdmin(false, grants);
    await Promise.all([refreshAdmin(), refreshAdmin(), refreshAdmin()]);

    expect(fetchNui).toHaveBeenCalledTimes(1);
  });
});
