// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { usePagedList } from './usePagedList.svelte';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('usePagedList', () => {
  it('shows the newest page and reports the rest as hidden', () => {
    const page = usePagedList({ items: () => rows(120), pageSize: 50 });

    expect(page.visible).toHaveLength(50);
    expect(page.hiddenCount).toBe(70);
    // A chat window holds the *end* of the list — the newest messages.
    expect(page.visible[0].id).toBe(70);
  });

  it('offsets the window so a positional index still addresses the right row', async () => {
    // The subtle one. Messages draws its unread divider by comparing a loop index to a
    // position in the full list; without the offset the divider lands on the wrong
    // message as soon as a page is revealed.
    const page = usePagedList({ items: () => rows(120), pageSize: 50 });
    expect(page.offset).toBe(70);
    expect(page.visible[0].id).toBe(page.offset);

    await page.loadMore();
    expect(page.offset).toBe(20);
    expect(page.visible[0].id).toBe(page.offset);
  });

  it('reveals a page at a time until nothing is hidden', async () => {
    const page = usePagedList({ items: () => rows(120), pageSize: 50 });

    await page.loadMore();
    expect(page.visible).toHaveLength(100);

    await page.loadMore();
    expect(page.visible).toHaveLength(120);
    expect(page.hiddenCount).toBe(0);
    expect(page.offset).toBe(0);

    // Nothing left to reveal, and asking again is not an error.
    await page.loadMore();
    expect(page.visible).toHaveLength(120);
  });

  it('does not window a list that already fits', () => {
    const page = usePagedList({ items: () => rows(10), pageSize: 50 });
    expect(page.visible).toHaveLength(10);
    expect(page.hiddenCount).toBe(0);
    expect(page.offset).toBe(0);
  });

  it('keeps the reader in place when older rows appear above them', async () => {
    // The piece that is easy to leave out and invisible until a thread is long: the
    // list grew upward, so the same content now sits lower by exactly the added height.
    let height = 1000;
    const el = {
      get scrollHeight() {
        return height;
      },
      scrollTop: 400,
      clientHeight: 300
    } as unknown as HTMLElement;

    const page = usePagedList({
      items: () => rows(200),
      pageSize: 50,
      olderAt: 'start',
      container: () => el
    });

    const promise = page.loadMore();
    height = 1600; // the newly revealed page added 600px above
    await promise;

    expect(el.scrollTop).toBe(1000); // 1600 - 1000 + 400
  });

  it('windows the other end, and does not touch scroll, for a feed', async () => {
    // A feed grows downward: older posts are below, so revealing them changes nothing
    // the reader is already looking at.
    const el = { scrollHeight: 1000, scrollTop: 400, clientHeight: 300 } as HTMLElement;
    const page = usePagedList({
      items: () => rows(120),
      pageSize: 50,
      olderAt: 'end',
      container: () => el
    });

    expect(page.visible[0].id).toBe(0);
    expect(page.offset).toBe(0);

    await page.loadMore();
    expect(page.visible).toHaveLength(100);
    expect(el.scrollTop).toBe(400);
  });

  it('asks for more when a chat is scrolled to the top', () => {
    const page = usePagedList({ items: () => rows(120), pageSize: 50, olderAt: 'start' });
    const target = { scrollTop: 5, scrollHeight: 1000, clientHeight: 300 };

    page.onScroll({ target } as unknown as Event);
    // Fires the load; the await happens inside. What matters here is that the edge was
    // recognized rather than that the page has already grown.
    expect(page.loading).toBe(true);
  });

  it('ignores a scroll nowhere near the edge', () => {
    const page = usePagedList({ items: () => rows(120), pageSize: 50, olderAt: 'start' });
    const target = { scrollTop: 800, scrollHeight: 1000, clientHeight: 300 };

    page.onScroll({ target } as unknown as Event);
    expect(page.loading).toBe(false);
  });

  it('goes back to one page when the list is replaced', async () => {
    const page = usePagedList({ items: () => rows(120), pageSize: 50 });
    await page.loadMore();
    expect(page.visible).toHaveLength(100);

    page.reset();
    expect(page.visible).toHaveLength(50);
  });

  it('does not run two loads at once', async () => {
    const page = usePagedList({ items: () => rows(500), pageSize: 50 });
    const spy = vi.spyOn(page, 'loading', 'get');

    const first = page.loadMore();
    await page.loadMore(); // re-entrant, must be a no-op
    await first;

    expect(page.visible).toHaveLength(100);
    spy.mockRestore();
  });
});
