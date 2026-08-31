// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';

const marketplaceMock = vi.hoisted(() => ({ postListing: vi.fn() }));
vi.mock('@gphone/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketplace: () => marketplaceMock
}));

import CreateListing from './CreateListing.svelte';

describe('CreateListing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Post is disabled until title, price, and description are all filled', async () => {
    render(CreateListing, { props: { onposted: () => {}, oncancel: () => {} } });
    // eslint's type info disagrees with svelte-check/tsc here: it sees this as redundant,
    // but tsc genuinely needs it (`screen.getByText` returns `HTMLElement`, which has no
    // `.disabled`) — confirmed by removing it and getting a real svelte-check error.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const post = screen.getByText('Post') as HTMLButtonElement;
    expect(post.disabled).toBe(true);

    await fireEvent.input(screen.getByPlaceholderText('Title'), { target: { value: 'Bike' } });
    await fireEvent.input(screen.getByPlaceholderText('Price'), { target: { value: '100' } });
    expect(post.disabled).toBe(true);

    await fireEvent.input(screen.getByPlaceholderText('Description'), {
      target: { value: 'good bike' }
    });
    expect(post.disabled).toBe(false);
  });

  it('submits title/price/description and calls onposted with the new id', async () => {
    marketplaceMock.postListing.mockResolvedValue({ id: 9 });
    const onposted = vi.fn();
    render(CreateListing, { props: { onposted, oncancel: () => {} } });

    await fireEvent.input(screen.getByPlaceholderText('Title'), { target: { value: 'Bike' } });
    await fireEvent.input(screen.getByPlaceholderText('Price'), { target: { value: '100' } });
    await fireEvent.input(screen.getByPlaceholderText('Description'), {
      target: { value: 'good bike' }
    });
    await fireEvent.click(screen.getByText('Post'));

    expect(marketplaceMock.postListing).toHaveBeenCalledWith({
      title: 'Bike',
      price: 100,
      description: 'good bike',
      attachments: []
    });
    expect(onposted).toHaveBeenCalledWith(9);
  });

  it('tapping Cancel calls oncancel', async () => {
    const oncancel = vi.fn();
    render(CreateListing, { props: { onposted: () => {}, oncancel } });
    await fireEvent.click(screen.getByText('Cancel'));
    expect(oncancel).toHaveBeenCalled();
  });
});
