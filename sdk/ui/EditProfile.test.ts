// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import EditProfile from './EditProfile.svelte';

const account = { handle: 'ada', display_name: 'Ada', bio: null };

/**
 * MICA-416. Blabber's and Glimpse's copies, once: a full-screen panel built as
 * `ConfirmDialog` is, saving a trimmed patch where an emptied field is a cleared column.
 */
describe('EditProfile', () => {
  it('is a modal dialog named by its title, and takes focus when it opens', async () => {
    const { getByRole } = render(EditProfile, { account, onsave: () => {}, oncancel: () => {} });
    await tick();
    const dialog = getByRole('dialog', { name: 'Edit profile' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
    expect(getByRole('heading', { level: 2, name: 'Edit profile' })).toBeTruthy();
  });

  it('takes the caller title for both the heading and the name', () => {
    const { getByRole } = render(EditProfile, {
      account,
      title: 'Your profile',
      onsave: () => {},
      oncancel: () => {}
    });
    expect(getByRole('dialog', { name: 'Your profile' })).toBeTruthy();
  });

  it('keeps Tab inside the panel', async () => {
    const { getByRole, getByLabelText } = render(EditProfile, {
      account,
      onsave: () => {},
      oncancel: () => {}
    });
    await tick();
    // Save is disabled until something changes, so Cancel is the last tabbable control.
    getByRole('button', { name: 'Cancel' }).focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(getByLabelText('Display name'));
  });

  it('labels each field, and saves only once something changed', async () => {
    const onsave = vi.fn();
    const { getByLabelText, getByRole } = render(EditProfile, {
      account,
      onsave,
      oncancel: () => {}
    });
    const save = getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await fireEvent.input(getByLabelText('Display name'), { target: { value: '  ' } });
    await fireEvent.input(getByLabelText('Bio'), { target: { value: ' counting machines ' } });
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    expect(onsave).toHaveBeenCalledWith({ display_name: null, bio: 'counting machines' });
  });

  it('cancels, and disables both buttons while busy', async () => {
    const oncancel = vi.fn();
    const idle = render(EditProfile, { account, onsave: () => {}, oncancel });
    await fireEvent.click(idle.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledOnce();
    idle.unmount();

    const busy = render(EditProfile, { account, busy: true, onsave: () => {}, oncancel });
    for (const button of busy.getAllByRole('button') as HTMLButtonElement[])
      expect(button.disabled).toBe(true);
  });
});
