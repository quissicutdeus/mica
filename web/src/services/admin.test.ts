import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

/**
 * `refreshAdmin` de-duplicates concurrent callers on a module-scope promise, so each test
 * needs its own copy of the module.
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

  it('costs one request however many callers want the answer at once', async () => {
    const { refreshAdmin, fetchNui } = await loadAdmin(false, grants);
    await Promise.all([refreshAdmin(), refreshAdmin(), refreshAdmin()]);

    expect(fetchNui).toHaveBeenCalledTimes(1);
  });

  it('asks again after the first answer has landed, so a character switch re-reads', async () => {
    // This used to be a `let asked = false` that never cleared, which made it "once per CEF
    // page" rather than once per player: `pushRehydrate` on a character switch calls
    // `resetBootstrapState()` and `bootstrapStores(true)` (`shell/nuiMessages.ts`), which
    // calls this again — and the latch swallowed it, so the next character inherited the
    // previous one's Administration icon for the rest of the session.
    let admin = true;
    const { isAdmin, refreshAdmin, fetchNui } = await loadAdmin(false, async () => ({
      isAdmin: admin
    }));

    await refreshAdmin();
    expect(get(isAdmin)).toBe(true);

    admin = false;
    await refreshAdmin();

    expect(fetchNui).toHaveBeenCalledTimes(2);
    expect(get(isAdmin)).toBe(false);
  });
});
