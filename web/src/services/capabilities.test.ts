// @vitest-environment jsdom
// The guard in `capabilities.ts` is `typeof window !== 'undefined' && isBrowser()`, so a
// node environment answers "not a browser" whatever `isBrowser` is mocked to — which is the
// point of the guard, and would make the browser stand-in untestable here without a window.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

/**
 * `refreshCapabilities` de-duplicates on a module-scope promise, so each test needs its own
 * copy of the module — the same reason, and the same `doMock` mechanics, as `admin.test.ts`.
 * A spy installed on the old instance never reaches the re-imported one's own imports.
 */
const loadCapabilities = async (browser: boolean, reply: () => Promise<unknown>) => {
  vi.resetModules();
  const fetchNui = vi.fn(reply);
  vi.doMock('../lib/sdk/isBrowser', () => ({ isBrowser: () => browser }));
  vi.doMock('../nui/fetchNui', () => ({ fetchNui, isBrowser: () => browser }));
  return { ...(await import('./capabilities')), fetchNui };
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('../lib/sdk/isBrowser'));

const hasMoney = async () => ({ money: true });

describe('capabilities store', () => {
  it('starts denied in game, so a missing endpoint hides an app rather than shipping a broken one', async () => {
    const { capabilities, capabilitiesKnown } = await loadCapabilities(false, hasMoney);

    expect(get(capabilities).money).toBe(false);
    expect(get(capabilitiesKnown)).toBe(false);
  });

  it('stands in as fully capable in a plain browser, whose mocks always have money', async () => {
    const { capabilities, capabilitiesKnown } = await loadCapabilities(true, hasMoney);

    expect(get(capabilities).money).toBe(true);
    expect(get(capabilitiesKnown)).toBe(true);
  });

  it('takes the server answer', async () => {
    const { capabilities, refreshCapabilities, fetchNui } = await loadCapabilities(false, hasMoney);
    await refreshCapabilities();

    expect(fetchNui).toHaveBeenCalledWith('checkCapabilities');
    expect(get(capabilities).money).toBe(true);
  });

  it('reads a capability the server omits as absent', async () => {
    const { capabilities, capabilitiesKnown, refreshCapabilities } = await loadCapabilities(
      false,
      async () => ({})
    );
    await refreshCapabilities();

    expect(get(capabilities).money).toBe(false);
    // Absent is a real answer, not a pending one — the install gate may act on it.
    expect(get(capabilitiesKnown)).toBe(true);
  });

  it('does not read anything short of `true` as a yes', async () => {
    const { capabilities, refreshCapabilities } = await loadCapabilities(false, async () => ({
      money: 'yes'
    }));
    await refreshCapabilities();

    expect(get(capabilities).money).toBe(false);
  });

  it('denies everything when the request fails', async () => {
    const { capabilities, capabilitiesKnown, refreshCapabilities } = await loadCapabilities(
      true,
      async () => {
        throw new Error('timeout');
      }
    );
    await refreshCapabilities();

    expect(get(capabilities).money).toBe(false);
    expect(get(capabilitiesKnown)).toBe(true);
  });

  it('costs one request however many callers want the answer at once', async () => {
    const { refreshCapabilities, fetchNui } = await loadCapabilities(false, hasMoney);
    await Promise.all([refreshCapabilities(), refreshCapabilities(), refreshCapabilities()]);

    expect(fetchNui).toHaveBeenCalledTimes(1);
  });

  it('asks again after the first answer has landed, so a character switch re-reads', async () => {
    // The defect this store was written not to repeat: `admin.ts` latched on a module-scope
    // `asked` that never cleared, so `pushRehydrate` calling `bootstrapStores(true)` on a
    // character switch got the previous character's answer back unchanged.
    let money = true;
    const { capabilities, refreshCapabilities, fetchNui } = await loadCapabilities(
      false,
      async () => ({ money })
    );

    await refreshCapabilities();
    expect(get(capabilities).money).toBe(true);

    money = false;
    await refreshCapabilities();

    expect(fetchNui).toHaveBeenCalledTimes(2);
    expect(get(capabilities).money).toBe(false);
  });
});
