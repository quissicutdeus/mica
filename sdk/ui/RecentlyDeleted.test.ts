// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import RecentlyDeleted from './RecentlyDeleted.svelte';

// jsdom has no Web Animations API, and the confirm dialog behind permanent delete uses
// `transition:fade` (via `lib/motion`) for both its in *and* its out transition. The
// `SendMoneyModal.test.ts` shim stops there because nothing in that suite outlives the
// intro — here the dialog is expected to actually leave the DOM once `pending` clears, and
// Svelte only removes an outro'd node once the `Animation` it drove calls `onfinish`. So
// this mock goes one step further and fires that callback itself, on a microtask, the way
// a real animation would resolve it.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn(function mockAnimate() {
    let onfinish: (() => void) | null = null;
    queueMicrotask(() => onfinish?.());
    return {
      cancel: () => {},
      finish: () => {},
      startTime: 0,
      currentTime: 0,
      effect: { getComputedTiming: () => ({ duration: 0 }) },
      set onfinish(fn: (() => void) | null) {
        onfinish = fn;
      },
      get onfinish() {
        return onfinish;
      }
    };
  }) as unknown as typeof Element.prototype.animate;
}

const ITEMS = [
  { id: 1, label: 'Old Contact', deletedAt: new Date().toISOString() },
  { id: 2, label: 'Grocery List', preview: 'milk, eggs, bread', deletedAt: Date.now() }
];

/**
 * The shared Contacts/Notes/Media "Recently Deleted" screen (MICA-75).
 *
 * It holds no server knowledge — `onrestore`/`onpermanentdelete` are handed a bare id and
 * it is up to each app what that id means — so what is worth pinning here is the one
 * thing it does decide on every caller's behalf: restore fires immediately, permanent
 * delete does not, and the two must never be confused for each other regardless of which
 * app is holding the list.
 */
describe('RecentlyDeleted', () => {
  it('shows an empty state when there is nothing to restore', () => {
    const { getByText, queryByText } = render(RecentlyDeleted, {
      items: [],
      onrestore: () => {},
      onpermanentdelete: () => {}
    });

    expect(getByText('Nothing here')).toBeTruthy();
    expect(queryByText('Old Contact')).toBeNull();
  });

  it('accepts custom empty-state copy per caller', () => {
    const { getByText } = render(RecentlyDeleted, {
      items: [],
      onrestore: () => {},
      onpermanentdelete: () => {},
      emptyTitle: 'No deleted notes',
      emptyDescription: 'Delete a note and it will show up here.'
    });

    expect(getByText('No deleted notes')).toBeTruthy();
    expect(getByText('Delete a note and it will show up here.')).toBeTruthy();
  });

  it('draws a row per item, with the optional preview line only where given', () => {
    const { getByText, queryByText } = render(RecentlyDeleted, {
      items: ITEMS,
      onrestore: () => {},
      onpermanentdelete: () => {}
    });

    expect(getByText('Old Contact')).toBeTruthy();
    expect(getByText('Grocery List')).toBeTruthy();
    expect(getByText('milk, eggs, bread')).toBeTruthy();
    // The first item supplied no preview — nothing should be invented for it.
    expect(queryByText('undefined')).toBeNull();
  });

  it('restores immediately — no confirmation step on the non-destructive path', () => {
    const onrestore = vi.fn();
    const { getAllByText } = render(RecentlyDeleted, {
      items: ITEMS,
      onrestore,
      onpermanentdelete: () => {}
    });

    getAllByText('Restore')[0].click();

    expect(onrestore).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not permanently delete on the first tap — it asks first', async () => {
    const onpermanentdelete = vi.fn();
    const { getByLabelText, queryByText } = render(RecentlyDeleted, {
      items: ITEMS,
      onrestore: () => {},
      onpermanentdelete
    });

    await fireEvent.click(getByLabelText('Delete Old Contact permanently'));

    expect(onpermanentdelete).not.toHaveBeenCalled();
    expect(queryByText('Delete permanently?')).toBeTruthy();
  });

  it('permanently deletes only once the confirmation is accepted', async () => {
    const onpermanentdelete = vi.fn();
    const { getByLabelText, getByText, queryByText } = render(RecentlyDeleted, {
      items: ITEMS,
      onrestore: () => {},
      onpermanentdelete
    });

    await fireEvent.click(getByLabelText('Delete Grocery List permanently'));
    await fireEvent.click(getByText('Delete'));

    expect(onpermanentdelete).toHaveBeenCalledExactlyOnceWith(2);
    // The dialog closes itself rather than leaving the caller to notice the list changed.
    expect(queryByText('Delete permanently?')).toBeNull();
  });

  /**
   * MICA-75-wiring: the server side of this ticket ships no hard-delete this round, so
   * a caller with nothing real to wire `onpermanentdelete` to — Contacts, Notes and Media,
   * today — omits it entirely rather than getting a delete-forever button that lies about
   * what it does.
   */
  it('renders restore-only, with no delete-forever affordance, when onpermanentdelete is omitted', () => {
    const { getByText, queryByLabelText } = render(RecentlyDeleted, {
      items: ITEMS,
      onrestore: () => {}
    });

    expect(getByText('Old Contact')).toBeTruthy();
    expect(queryByLabelText('Delete Old Contact permanently')).toBeNull();
  });

  it('backs out of a permanent delete on cancel, and the row survives', async () => {
    const onpermanentdelete = vi.fn();
    const { getByLabelText, getByText, queryByText } = render(RecentlyDeleted, {
      items: ITEMS,
      onrestore: () => {},
      onpermanentdelete
    });

    await fireEvent.click(getByLabelText('Delete Old Contact permanently'));
    await fireEvent.click(getByText('Cancel'));

    expect(onpermanentdelete).not.toHaveBeenCalled();
    expect(queryByText('Delete permanently?')).toBeNull();
    expect(getByText('Old Contact')).toBeTruthy();
  });
});
