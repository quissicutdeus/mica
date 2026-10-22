// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { renderApp } from '@mica/sdk/testing';
import type { Account, NotificationItem } from '@mica/shared/types';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));
import { fetchNui } from '../../nui/fetchNui';
import { registerNuiTransport } from '../../../../sdk/nui/transport';
import { locale } from '../../../../sdk/i18n';

import Blabber from './index.svelte';
import LauncherIcon from './Icon.svelte';
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

/** What `accounts:mine` answers; one handle unless a test empties it. */
let owned: Account[] = [];

/** One mention with a sender avatar, for the Notifications tab. */
const mention: NotificationItem = {
  id: 7,
  citizenid: 'TEST1',
  app: 'blabber',
  kind: 'mention',
  title: '@ada mentioned you',
  body: 'hi @echo',
  avatar: 'data:image/png;base64,AAAA',
  deep_link: null,
  read_at: null,
  created_at: '2026-10-22T00:00:00Z',
  updated_at: '2026-10-22T00:00:00Z'
};

beforeEach(() => {
  owned = [account];
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
      if (action === 'accounts:mine') return { rows: owned, limit: 3 };
      if (action === 'blabber:feed') return { rows: [], nextCursor: null };
      if (action.endsWith(':getShadeNotifications') || action.endsWith(':getNotificationHistory'))
        return [mention];
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

  /** MICA-416: the SDK's `EditProfile`, a dialog named for its title that takes focus. */
  it('opens Edit profile as a modal dialog that takes focus', async () => {
    const { findByRole } = renderApp(Blabber, { id: 'blabber' });
    await fireEvent.click(await findByRole('button', { name: 'Posting as @echo' }));
    await fireEvent.click(await findByRole('button', { name: 'Edit profile' }));

    const dialog = await findByRole('dialog', { name: 'Edit profile' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(await findByRole('textbox', { name: 'Display name' })).toBeTruthy();
  });

  /** MICA-416: the gate is the SDK's `ClaimHandle`, whose field is named for its title. */
  it('gates a player with no handle on a labelled claim field', async () => {
    owned = [];
    const { findByRole } = renderApp(Blabber, { id: 'blabber' });
    expect(await findByRole('textbox', { name: 'Pick a handle' })).toBeTruthy();
  });

  /**
   * MICA-420: the sender's avatar was passed `size="md"`, which is no class, so it drew at no
   * size at all. It is the same 40px as the activity badge drawn when there is no avatar.
   */
  it('draws a notification avatar at the 40px the badge beside it uses', async () => {
    const { findByRole } = renderApp(Blabber, { id: 'blabber' });
    await fireEvent.click(await findByRole('button', { name: 'Notifications' }));

    const img = await waitFor(() => {
      const found = document.querySelector(`img[src="${mention.avatar}"]`);
      expect(found).not.toBeNull();
      return found;
    });
    const box = img?.parentElement;
    expect(box?.classList.contains('w-10')).toBe(true);
    expect(box?.classList.contains('h-10')).toBe(true);
  });
});

/** MICA-420: the launcher glyph's fallback size is the `size-icon-xl` token, not a raw `h-8 w-8`. */
describe('launcher icon', () => {
  it('draws at the xl icon token when the shell passes no class', () => {
    const { container } = render(LauncherIcon);
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('size-icon-xl');
  });
});
