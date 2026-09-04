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
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';

import Composer from './Composer.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

// MICA-215: the catalog is registered by `index.svelte`, which a component test does not
// mount — so this file registers it itself, or every label renders as its own key.
registerMessages('blabber', { en, de });

/**
 * MICA-100.
 *
 * The reply composer is mounted for the life of the thread, and it never cleared itself after a
 * successful post — so a second tap of Post filed an identical duplicate. The public composer
 * hid this: `index.svelte` unmounts it on submit, so it had nothing to clear.
 */
describe('Composer', () => {
  // The generic rather than an `as` assertion: `getByText` defaults to `HTMLElement`, which has
  // no `.disabled`, and an assertion here is one eslint rejects as redundant.
  const post = () => screen.getByText<HTMLButtonElement>('Post');
  const field = () => screen.getByPlaceholderText('Post your reply');

  const type = (value: string) => fireEvent.input(field(), { target: { value } });

  it('clears the draft after a successful submit', async () => {
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(Composer, { props: { placeholder: 'Post your reply', onsubmit } });

    await type('same, brutal today');
    await fireEvent.click(post());

    expect(onsubmit).toHaveBeenCalledWith('same, brutal today', undefined);
    expect((field() as HTMLTextAreaElement).value).toBe('');
  });

  it('disables Post once the draft is cleared, so the same reply cannot be filed twice', async () => {
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(Composer, { props: { placeholder: 'Post your reply', onsubmit } });

    await type('same, brutal today');
    expect(post().disabled).toBe(false);

    await fireEvent.click(post());
    expect(post().disabled).toBe(true);

    // The gesture from the ticket: tap Post again without touching anything.
    await fireEvent.click(post());
    expect(onsubmit).toHaveBeenCalledTimes(1);
  });

  it('refuses a second submit while the first is still in flight', async () => {
    let release: (() => void) | undefined;
    const onsubmit = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    render(Composer, { props: { placeholder: 'Post your reply', onsubmit } });

    await type('same, brutal today');
    // Held by reference rather than re-queried: the label reads "…" while the post is in
    // flight, so `getByText('Post')` would not find the very button under test.
    const button = post();
    await fireEvent.click(button);

    // Still in flight: the text is deliberately still there, and the button is shut.
    expect(button.disabled).toBe(true);
    expect(button.textContent?.trim()).toBe('…');
    await fireEvent.click(button);
    expect(onsubmit).toHaveBeenCalledTimes(1);

    release?.();
  });

  it('keeps the draft when the post fails, so the words are not thrown away', async () => {
    const onsubmit = vi.fn().mockRejectedValue(new Error('nope'));
    render(Composer, { props: { placeholder: 'Post your reply', onsubmit } });

    await type('same, brutal today');
    await fireEvent.click(post());

    expect((field() as HTMLTextAreaElement).value).toBe('same, brutal today');
    // And it is offered again rather than being wedged shut by the failure.
    expect(post().disabled).toBe(false);
  });
});
