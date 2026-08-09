import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { get } from 'svelte/store';
import manifest from './manifest';
import { dmThreads, unreadDms } from './store';
import { unreadCounts, shadeNotifications } from '../../services/notifications';

/**
 * What the launcher badge counts.
 *
 * This is a regression test with a specific bug behind it. The badge used to sum three stores —
 * an in-memory mention counter, the unread total derived from DM threads, and the OS notification
 * count — and the server persists a `gphone_notifications` row for the very mentions and DMs the
 * first two were counting. So one mention put **2** on the launcher and one DM put 2 more, and
 * the number grew at twice the rate of the thing it described.
 *
 * Pinned here rather than left to review, because the failure is invisible in the one place
 * anybody would look: every individual store held the right number.
 */

/**
 * Subscribe and read, which is what `lazyBadge` needs — it composes on first subscribe.
 *
 * It emits `0` synchronously and swaps in the real store only once `import('@gphone/sdk')` and
 * the app's own store have resolved, so the composed value takes an indeterminate number of
 * ticks to arrive. Settling for a fixed delay would make this pass for the wrong reason on a slow
 * run and flake on a fast one; waiting for the subscription to fire again is the actual signal.
 */
const readBadge = async (): Promise<number> => {
  let value = -1;
  let updates = 0;
  const stop = manifest.badgeStore!.subscribe((n) => {
    value = n;
    updates += 1;
  });

  // The first emission is `lazyBadge`'s placeholder; the second is the composed store. After the
  // first call the composition is cached, so later reads settle immediately.
  for (let tick = 0; tick < 200 && updates < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  stop();
  return value;
};

beforeAll(async () => {
  // Resolve what `lazyBadge` will reach for, before anything is timed against it. A cold
  // `import('@gphone/sdk')` is much slower than the composition itself, and warming it here is
  // what keeps these tests measuring the badge rather than the module loader.
  await import('@gphone/sdk');
  await import('./store');
  await readBadge();
});

describe('the Blabber launcher badge', () => {
  beforeEach(() => {
    unreadCounts.set({});
    shadeNotifications.set([]);
    dmThreads.set([]);
  });

  it('counts each unread notification exactly once', async () => {
    // One mention. The server wrote one row, so the badge says one — not two.
    unreadCounts.set({ blabber: 1 });

    await expect(readBadge()).resolves.toBe(1);
  });

  it('counts only this app', async () => {
    // The shade is one list for the whole phone; a badge is one app's slice of it.
    unreadCounts.set({ blabber: 2, messages: 7, mail: 3 });

    await expect(readBadge()).resolves.toBe(2);
  });

  it('is zero when nothing is unread', async () => {
    unreadCounts.set({ messages: 4 });

    await expect(readBadge()).resolves.toBe(0);
  });

  it('does not add unread DM threads on top of the rows counting them', async () => {
    /**
     * The double count, pinned directly.
     *
     * Every DM push carries a `notify` block, so the server has already written a notification
     * row for each of these threads — they are the same three unread messages seen twice. The
     * badge summing `unreadDms` as well is what made one DM show 2.
     *
     * `unreadDms` is not wrong, and it is still on the header DM icon: "unread in this thread"
     * is a real question. It is just not the question a launcher badge asks.
     */
    dmThreads.set([
      { peer_account_id: 2, handle: 'bob', display_name: 'Bob', unread: 2, last: null },
      { peer_account_id: 3, handle: 'cass', display_name: 'Cass', unread: 1, last: null }
    ]);
    unreadCounts.set({ blabber: 3 });

    expect(get(unreadDms)).toBe(3);
    await expect(readBadge()).resolves.toBe(3);
  });
});
