// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';

const marketplaceMock = vi.hoisted(() => ({ postListing: vi.fn() }));
vi.mock('@gos/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMarketplace: () => marketplaceMock
}));

import CreateListing from './CreateListing.svelte';

import { registerMessages } from '@gos/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

// MICA-215: `index.svelte` registers the `marketplace` namespace for the running app.
// This test renders one screen on its own, so it stands in for the entry point —
// otherwise every `$t` here resolves to its own key.
registerMessages('marketplace', { en, de });

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
