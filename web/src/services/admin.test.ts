// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

/**
 * `refreshAdmin` de-duplicates concurrent callers on a module-scope promise, so each test
 * needs its own copy of the module.
 *
 * Mocked with `doMock` rather than `spyOn`: `resetModules` gives the re-imported module
 * fresh copies of its own imports too, which a spy installed on the old instance never
 * reaches.
 */
const loadAdmin = async (
  browser: boolean,
  reply: (event: string, data?: unknown, options?: { defaultValue?: unknown }) => Promise<unknown>
) => {
  vi.resetModules();
  const fetchNui = vi.fn(reply);
  vi.doMock('../../../sdk/lib/isBrowser', () => ({ isBrowser: () => browser }));
  vi.doMock('../nui/fetchNui', () => ({ fetchNui, isBrowser: () => browser }));
  return { ...(await import('./admin')), fetchNui };
};

/**
 * Pay the cold import once, outside any test's budget.
 *
 * `loadAdmin` re-imports `./admin` per test, and the first import in a fresh worker
 * transforms the whole graph behind it — `@mica/sdk`, the contracts, the NUI call — while
 * every later one re-executes from the transform cache in about 20ms. Locally that first
 * import is under a second; on the Forgejo runner it crossed the 20s `testTimeout` on every
 * push from run 76 (5779b36a) to run 80, always in this file's first test, while the other
 * five and the rest of the suite passed. The test was not hung, it was first in line. Warming
 * the import here keeps the per-test timeout meaning "hung" rather than "cold", and the hook
 * gets its own generous ceiling so the warm-up itself cannot become the timeout.
 */
beforeAll(async () => {
  await import('./admin');
}, 60_000);

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('../../../sdk/lib/isBrowser'));

const grants = async () => ({ isAdmin: true });

/**
 * A refused request, answered the way the real `fetchNui` answers one: the default when the
 * caller asked for one, a throw when it did not. A bare rejection would skip the defaulting
 * and pass against code that reads a failure as an answer.
 */
const refuses = async (_event: string, _data?: unknown, options?: { defaultValue?: unknown }) => {
  if (options?.defaultValue !== undefined) return options.defaultValue;
  throw new Error('Player not authenticated');
};

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

  /**
   * MICA-384. A failed ask set `isAdmin` false and stopped, which read exactly like "holds no
   * ace": the first ask is the one likeliest to fail, at resource start before a character has
   * loaded, and nothing asked again until a character switch.
   */
  describe('a failed ask', () => {
    it('stays hidden, and is not an answer', async () => {
      const { isAdmin, adminKnown, refreshAdmin } = await loadAdmin(false, refuses);
      await refreshAdmin();

      expect(get(isAdmin)).toBe(false);
      expect(get(adminKnown)).toBe(false);
    });

    it('is asked again by the next ensure, which then takes the answer', async () => {
      let fail = true;
      const { isAdmin, adminKnown, refreshAdmin, ensureAdmin, fetchNui } = await loadAdmin(
        false,
        (event, data, options) => (fail ? refuses(event, data, options) : grants())
      );
      await refreshAdmin();

      fail = false;
      await ensureAdmin();

      expect(fetchNui).toHaveBeenCalledTimes(2);
      expect(get(isAdmin)).toBe(true);
      expect(get(adminKnown)).toBe(true);
    });

    it('reads a reply without a boolean as unknown, not as a grant or a refusal', async () => {
      const { isAdmin, adminKnown, refreshAdmin } = await loadAdmin(false, async () => null);
      await refreshAdmin();

      expect(get(isAdmin)).toBe(false);
      expect(get(adminKnown)).toBe(false);
    });

    it('does not keep a grant through a failed re-ask', async () => {
      // A forced re-ask is a character switch: the next character must not inherit the last
      // one's Administration icon because the request for theirs failed.
      let fail = false;
      const { isAdmin, adminKnown, refreshAdmin } = await loadAdmin(false, (e, d, o) =>
        fail ? refuses(e, d, o) : grants()
      );
      await refreshAdmin();
      expect(get(isAdmin)).toBe(true);

      fail = true;
      await refreshAdmin();

      expect(get(isAdmin)).toBe(false);
      expect(get(adminKnown)).toBe(false);
    });
  });

  it('ensure asks nothing once the server has answered', async () => {
    const { refreshAdmin, ensureAdmin, fetchNui } = await loadAdmin(false, grants);
    await refreshAdmin();
    await ensureAdmin();

    expect(fetchNui).toHaveBeenCalledTimes(1);
  });

  it('ensure asks nothing in a plain browser', async () => {
    const { ensureAdmin, adminKnown, fetchNui } = await loadAdmin(true, grants);
    await ensureAdmin();

    expect(fetchNui).not.toHaveBeenCalled();
    expect(get(adminKnown)).toBe(true);
  });
});
