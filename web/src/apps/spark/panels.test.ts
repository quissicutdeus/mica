// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { renderApp } from '@mica/sdk/testing';
import type { SparkCard, SparkMatch, SparkProfile } from '@mica/shared/types';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));
import { fetchNui } from '../../nui/fetchNui';
import { registerNuiTransport } from '../../../../sdk/nui/transport';

import Spark from './index.svelte';
import { profile, profileLoaded, matches, matchesLoaded } from './store';

const card: SparkCard = {
  id: 2,
  account_id: 12,
  display_name: 'Maya',
  age: 27,
  bio: null,
  looking_for: null,
  photos: []
};

const mine: SparkProfile = {
  ...card,
  id: 1,
  account_id: 11,
  display_name: 'Echo',
  status: 'active',
  photo_ids: []
};

const match: SparkMatch = { id: 5, profile: card, created_at: '2026-10-22T00:00:00Z' };

/** A contracted call arrives as `svc` with `{ service, action }` inside. */
const actionOf = (name: string, payload: unknown): string => {
  if (name !== 'svc') return name;
  const p = payload as { service?: string; action?: string };
  return `${p?.service}:${p?.action}`;
};

beforeEach(() => {
  profile.set(null);
  profileLoaded.set(false);
  matches.set([]);
  matchesLoaded.set(false);
  // The paged deck reaches the transport through the SDK seam, not this module's import.
  registerNuiTransport((...args) => fetchNui(...args));
  vi.mocked(fetchNui).mockImplementation(
    async (name: string, payload?: unknown, options?: { defaultValue?: unknown }) => {
      const action = actionOf(name, payload);
      if (action === 'spark:mine') return mine;
      if (action === 'spark:deck') return { rows: [card], nextCursor: null };
      if (action === 'spark:matches') return [];
      if (action === 'spark:swipe') return { match };
      return options?.defaultValue ?? null;
    }
  );
});

/**
 * MICA-410. The "It's a match" screen covers the deck with `absolute inset-0`, and covering is
 * not hiding: without dialog semantics the deck behind stayed in the tab order and a screen
 * reader was never told a new surface had opened.
 */
describe('Spark full-screen panels', () => {
  it('opens the match screen as a modal dialog that takes focus and keeps Tab inside', async () => {
    const { findByRole, findByTestId } = renderApp(Spark, { id: 'spark' });
    await fireEvent.click(await findByTestId('spark-like'));

    const dialog = await findByRole('dialog', { name: "It's a match!" });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    // Tab off the last button must wrap to the first; jsdom has no native Tab order, so without
    // `focusTrap` nothing moves.
    const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
    expect(buttons.length).toBeGreaterThan(1);
    buttons[buttons.length - 1].focus();
    await fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  /**
   * MICA-410: the match menu is the SDK's `AccountMenu`, a dialog, not the app's own panel, and
   * keeps the testids `spark.spec.ts` drives it by.
   */
  it('opens the match menu as a modal dialog that takes focus, with its testids', async () => {
    const { findByRole, findByTestId } = renderApp(Spark, { id: 'spark' });
    await fireEvent.click(await findByTestId('spark-like'));
    await fireEvent.click(await findByTestId('spark-matched-message'));
    await fireEvent.click(await findByTestId('spark-match-actions'));

    const dialog = await findByRole('dialog', { name: 'Match options' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('data-testid')).toBe('spark-match-menu');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(
      Array.from(dialog.querySelectorAll('button')).map((b) => b.getAttribute('data-testid'))
    ).toEqual(['spark-view-profile', 'spark-unmatch', 'spark-block', 'spark-report-profile']);
  });
});
