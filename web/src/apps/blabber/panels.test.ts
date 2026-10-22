// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { renderApp } from '@mica/sdk/testing';
import type { Account } from '@mica/shared/types';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));
import { fetchNui } from '../../nui/fetchNui';
import { registerNuiTransport } from '../../../../sdk/nui/transport';
import { locale } from '../../../../sdk/i18n';

import Blabber from './index.svelte';
import { myAccounts, accountsLoaded, activeAccountId } from './store';

const account: Account = {
  id: 1,
  citizenid: 'TEST1',
  app: 'blabber',
  handle: 'echo',
  display_name: null,
  bio: null,
  avatar: null,
  created_at: '2026-10-22T00:00:00Z',
  updated_at: '2026-10-22T00:00:00Z'
};

beforeEach(() => {
  locale.set('en');
  myAccounts.set([]);
  accountsLoaded.set(false);
  activeAccountId.set(null);
  // `createCrudStore` and the paged stores reach the transport through the SDK seam, not this
  // module's import, so the seam is pointed at the mock too (see store.test.ts).
  registerNuiTransport((...args) => fetchNui(...args));
  vi.mocked(fetchNui).mockImplementation(
    async (name: string, payload?: unknown, options?: { defaultValue?: unknown }) => {
      const action = actionOf(name, payload);
      if (action === 'accounts:mine') return { rows: [account], limit: 3 };
      if (action === 'blabber:feed') return { rows: [], nextCursor: null };
      return options?.defaultValue ?? null;
    }
  );
});

/** A contracted call arrives as `svc` with `{ service, action }` inside (see store.test.ts). */
const actionOf = (name: string, payload: unknown): string => {
  if (name !== 'svc') return name;
  const p = payload as { service?: string; action?: string };
  return `${p?.service}:${p?.action}`;
};

/**
 * Tab off the last tabbable inside `dialog` must land on its first. jsdom has no native Tab
 * order, so without `focusTrap` nothing moves and focus stays on the last control.
 */
const expectTrapped = async (dialog: HTMLElement) => {
  const tabbables = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
    )
  );
  expect(tabbables.length).toBeGreaterThan(1);
  tabbables[tabbables.length - 1].focus();
  await fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(tabbables[0]);
};

/**
 * MICA-410. The composer and the claim screen cover the feed with `absolute inset-0`, and
 * covering is not hiding: without dialog semantics the feed behind stayed in the tab order and
 * a screen reader was never told a new surface had opened.
 */
describe('Blabber full-screen panels', () => {
  it('opens the composer as a modal dialog that takes focus and keeps Tab inside', async () => {
    const { findByRole } = renderApp(Blabber, { id: 'blabber' });
    await fireEvent.click(await findByRole('button', { name: 'Blab' }));

    const dialog = await findByRole('dialog', { name: 'New Blab' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    await expectTrapped(dialog);
  });

  /** MICA-420: the prompt was an English literal, so a German phone asked in English. */
  it("prompts the new-Blab composer from the catalog, in the player's language", async () => {
    locale.set('de');
    const { findByRole, findByPlaceholderText } = renderApp(Blabber, { id: 'blabber' });
    await fireEvent.click(await findByRole('button', { name: 'Blab' }));
    expect(await findByPlaceholderText('Was gibt es Neues?')).toBeTruthy();
  });

  it('opens the claim screen as a modal dialog that takes focus and keeps Tab inside', async () => {
    const { findByRole } = renderApp(Blabber, { id: 'blabber' });
    await fireEvent.click(await findByRole('button', { name: 'Posting as @echo' }));
    await fireEvent.click(await findByRole('button', { name: /Claim another handle/ }));

    const dialog = await findByRole('dialog', { name: 'New handle' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    await expectTrapped(dialog);
  });

  /** MICA-410: the account menu is the SDK's `AccountMenu`, a dialog, not the app's own panel. */
  it('opens the account menu as a modal dialog that takes focus and keeps Tab inside', async () => {
    const { findByRole } = renderApp(Blabber, { id: 'blabber' });
    await fireEvent.click(await findByRole('button', { name: 'Posting as @echo' }));

    const dialog = await findByRole('dialog', { name: 'Posting as' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(dialog.textContent).toContain('Posting as · 1 of 3');
    expect(
      Array.from(dialog.querySelectorAll('button')).map((b) =>
        b.textContent?.replace(/\s+/g, ' ').trim()
      )
    ).toEqual(['echo @echo', 'Edit profile', 'Claim another handle']);
    await expectTrapped(dialog);
  });

  /** MICA-417: the header avatar draws the SDK's initials, not the first two characters. */
  it("draws the active handle's initials through initialsOf", async () => {
    const { findByRole } = renderApp(Blabber, { id: 'blabber' });
    const avatarButton = await findByRole('button', { name: 'Posting as @echo' });
    expect(avatarButton.querySelector('[data-initials]')?.getAttribute('data-initials')).toBe('E');
  });
});
