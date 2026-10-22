// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ClaimHandle from './ClaimHandle.svelte';

/**
 * MICA-416. Blabber's and Glimpse's copies, once. Claim waits for a handle the server's
 * pattern would take; Cancel is drawn only when the caller has somewhere to go back to.
 */
describe('ClaimHandle', () => {
  it('draws the default words, or the caller title and hint', () => {
    const plain = render(ClaimHandle, { onclaim: () => {} });
    expect(plain.getByRole('heading', { level: 2, name: 'Pick a handle' })).toBeTruthy();
    plain.unmount();

    const glimpse = render(ClaimHandle, {
      onclaim: () => {},
      hint: 'This is how people find you on Glimpse.'
    });
    expect(glimpse.getByText('This is how people find you on Glimpse.')).toBeTruthy();
  });

  it('claims a valid handle, lowercased, and refuses one the server would', async () => {
    const onclaim = vi.fn();
    const { getByLabelText, getByRole } = render(ClaimHandle, { onclaim });
    const input = getByLabelText('Pick a handle');
    const claim = getByRole('button', { name: 'Claim' }) as HTMLButtonElement;

    await fireEvent.input(input, { target: { value: 'ab' } });
    expect(claim.disabled).toBe(true);
    await fireEvent.input(input, { target: { value: 'has space' } });
    expect(claim.disabled).toBe(true);

    await fireEvent.input(input, { target: { value: 'Ada_L' } });
    expect(claim.disabled).toBe(false);
    await fireEvent.click(claim);
    expect(onclaim).toHaveBeenCalledWith('ada_l');
  });

  it('draws Cancel only when the caller passes oncancel', async () => {
    const gate = render(ClaimHandle, { onclaim: () => {} });
    expect(gate.queryByRole('button', { name: 'Cancel' })).toBeNull();
    gate.unmount();

    const oncancel = vi.fn();
    const overlay = render(ClaimHandle, { onclaim: () => {}, oncancel });
    await fireEvent.click(overlay.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledOnce();
  });
});
