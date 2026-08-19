// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';

const marketplaceMock = vi.hoisted(() => ({ postListing: vi.fn() }));
vi.mock('../../../sdk/hooks/useMarketplace', () => ({ useMarketplace: () => marketplaceMock }));

import CreateListing from './CreateListing.svelte';

describe('CreateListing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Post is disabled until title, price, and description are all filled', async () => {
    render(CreateListing, { props: { onposted: () => {}, oncancel: () => {} } });
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
