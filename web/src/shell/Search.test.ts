// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import Search from './Search.svelte';
import { closeSearch, isSearchOpen, searchQuery } from './state/search';

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  }) as unknown as Element['animate'];
}

const type = async (text: string) => {
  const input = screen.getByLabelText('Search apps, contacts and messages');
  await fireEvent.input(input, { target: { value: text } });
};

beforeEach(() => {
  closeSearch();
});

describe('Search', () => {
  it('shows a collapsed bar until it is tapped', async () => {
    render(Search, { props: { openApp: () => {} } });

    expect(screen.getByLabelText('Search')).toBeTruthy();
    await fireEvent.click(screen.getByLabelText('Search'));

    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy();
  });

  it('lists matching apps as the query is typed', async () => {
    render(Search, { props: { openApp: () => {} } });
    await fireEvent.click(screen.getByLabelText('Search'));

    await type('camer');

    expect(screen.getByText('Apps')).toBeTruthy();
    expect(screen.getByText('Camera')).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    render(Search, { props: { openApp: () => {} } });
    await fireEvent.click(screen.getByLabelText('Search'));

    await type('zzzznope');

    expect(screen.getByText(/No results for/)).toBeTruthy();
  });

  it('opening an app result closes the sheet and clears the query', async () => {
    const openApp = vi.fn();
    render(Search, { props: { openApp } });
    await fireEvent.click(screen.getByLabelText('Search'));
    await type('camer');

    await fireEvent.click(screen.getByText('Camera'));

    expect(openApp).toHaveBeenCalledWith('camera');

    // Asserted on the store rather than on the sheet being gone from the DOM: the sheet
    // leaves via `transition:fly`, and an outro keeps the node mounted for its duration.
    let open = true;
    isSearchOpen.subscribe((v) => (open = v))();
    expect(open).toBe(false);

    let query = 'unset';
    searchQuery.subscribe((v) => (query = v))();
    expect(query).toBe('');
  });

  it('depends on Contacts and Messages preloading their stores at boot', async () => {
    // Search reads those two stores and never fetches for itself. Both apps declare a
    // `preload` that `bootstrapStores` runs when the phone opens, which is what puts data
    // there before the home screen paints. Dropping either `preload` would not break that
    // app — its own screens load on foreground — but contacts or conversations would
    // silently vanish from search until the app had been opened once.
    const [contactsManifest, messagesManifest] = await Promise.all([
      import('../apps/contacts/manifest'),
      import('../apps/messages/manifest')
    ]);

    expect(contactsManifest.default.preload).toBeTypeOf('function');
    expect(messagesManifest.default.preload).toBeTypeOf('function');
  });

  it('the top handle closes the sheet', async () => {
    // The handle rather than the scrim: the scrim is covered by the status bar in the real
    // shell and cannot be tapped there, so a test that clicked it would be exercising a
    // path no player has. See the note on the handle in `Search.svelte`.
    render(Search, { props: { openApp: () => {} } });
    await fireEvent.click(screen.getByLabelText('Search'));

    let open = true;
    const stop = isSearchOpen.subscribe((v) => (open = v));
    await fireEvent.click(screen.getByLabelText('Close search'));
    stop();

    expect(open).toBe(false);
  });

  it('closes itself when it is unmounted with the sheet still open', async () => {
    // The shell only renders this component while the home screen is showing, so anything
    // that opens an app over an open search — an incoming call, a notification deep link —
    // unmounts it mid-flight. Left open, its `back` keybind handler stays registered and
    // would later swallow a Back press meant for whatever is actually on screen.
    const { unmount } = render(Search, { props: { openApp: () => {} } });
    await fireEvent.click(screen.getByLabelText('Search'));

    unmount();

    let open = true;
    isSearchOpen.subscribe((v) => (open = v))();
    expect(open).toBe(false);
  });
});
