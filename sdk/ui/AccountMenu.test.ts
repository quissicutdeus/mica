// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import AccountMenu from './AccountMenu.svelte';

const accounts = [
  { id: 1, handle: 'ada', display_name: 'Ada Lovelace', avatar: null },
  { id: 2, handle: 'grace', display_name: null }
];

const tab = (shiftKey = false) =>
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  );

/**
 * MICA-410. One menu for Blabber's and Glimpse's identity switcher and Spark's match menu,
 * built as `ConfirmDialog` is: a modal dialog named by the caller, focused on open, Tab kept
 * inside it, every item a button. Back is the app's levels, so nothing here listens for keys.
 */
describe('AccountMenu', () => {
  it('is a modal dialog named by its label, and takes focus when it opens', async () => {
    const { getByRole } = render(AccountMenu, {
      label: 'Accounts',
      closeLabel: 'Close menu',
      onclose: () => {}
    });
    await tick();
    const dialog = getByRole('dialog', { name: 'Accounts' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
  });

  it('keeps Tab inside the panel, wrapping both ways', async () => {
    const { getByRole } = render(AccountMenu, {
      label: 'Match options',
      closeLabel: 'Close menu',
      actions: [
        { label: 'View profile', onselect: () => {} },
        { label: 'Report', onselect: () => {}, tone: 'danger' }
      ],
      onclose: () => {}
    });
    await tick();
    const first = getByRole('button', { name: 'View profile' });
    const last = getByRole('button', { name: 'Report' });

    // Focus is on the dialog itself, inside the trap: Tab lands on the first item.
    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
    tab(true);
    expect(document.activeElement).toBe(last);
  });

  it('closes on a tap of the scrim, named by closeLabel', async () => {
    const onclose = vi.fn();
    const { getByRole } = render(AccountMenu, {
      label: 'Accounts',
      closeLabel: 'Close menu',
      onclose
    });
    await fireEvent.click(getByRole('button', { name: 'Close menu' }));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('draws each account as a pressed-or-not button and switches by id', async () => {
    const onswitch = vi.fn();
    const { getAllByRole, getByText } = render(AccountMenu, {
      label: 'Accounts',
      closeLabel: 'Close menu',
      heading: 'Posting as (2 of 3)',
      accounts,
      activeId: 1,
      onswitch,
      onclose: () => {}
    });
    expect(getByText('Posting as (2 of 3)')).toBeTruthy();
    const pressed = getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed'));
    expect(pressed.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    // No display name falls back to the handle.
    expect(pressed[1].textContent).toContain('grace');
    await fireEvent.click(pressed[1]);
    expect(onswitch).toHaveBeenCalledWith(2);
  });

  it('runs an action, tones a dangerous one, and carries its testid', async () => {
    const onblock = vi.fn();
    const { getByRole, getByTestId } = render(AccountMenu, {
      label: 'Match options',
      closeLabel: 'Close menu',
      actions: [
        { label: 'Unmatch', onselect: () => {} },
        { label: 'Block', onselect: onblock, tone: 'danger', testid: 'spark-block' }
      ],
      onclose: () => {},
      testid: 'spark-match-menu'
    });
    const block = getByRole('button', { name: 'Block' });
    expect(block.classList.contains('text-error')).toBe(true);
    expect(getByRole('button', { name: 'Unmatch' }).classList.contains('text-error')).toBe(false);
    expect(getByTestId('spark-block')).toBe(block);
    expect(getByTestId('spark-match-menu').getAttribute('role')).toBe('dialog');
    await fireEvent.click(block);
    expect(onblock).toHaveBeenCalledOnce();
  });

  it('draws no accounts without onswitch to send a tap to', () => {
    const { getByRole } = render(AccountMenu, {
      label: 'Accounts',
      closeLabel: 'Close menu',
      accounts,
      onclose: () => {}
    });
    expect(getByRole('dialog').querySelector('[aria-pressed]')).toBeNull();
  });
});
