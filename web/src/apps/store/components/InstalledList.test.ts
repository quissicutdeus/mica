// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../../host/registerFacets';
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import { registerMessages, type AppManifest } from '@mica/sdk';
import { locale } from '../../../../../sdk/i18n';
import en from '../locales/en.json';
import de from '../locales/de.json';
import InstalledList from './InstalledList.svelte';

registerMessages('store', { en, de });

const app = (id: string, installedAt?: string): AppManifest =>
  ({
    id,
    name: id,
    version: '1.0.0',
    description: 'd',
    tile: { bg: 'bg-indigo-600' },
    installedAt
  }) as AppManifest;

const props = (apps: AppManifest[]) => ({
  apps,
  filter: 'all' as const,
  sortOrder: 'newest' as const,
  onselect: () => {},
  onopen: () => {},
  onupdate: () => {}
});

describe('InstalledList', () => {
  afterEach(() => locale.set('en'));

  /**
   * MICA-418: the All / System / Add-ons filter was three hand-rolled buttons with no
   * `type="button"`, so inside any form each one was a submit. The SDK's
   * `SegmentedControl` is the shared row of toggles.
   */
  it('filters with plain toggle buttons, exactly one pressed', async () => {
    render(InstalledList, props([app('notes')]));
    const names = ['All', 'System', 'Add-ons'];
    const chips = names.map((name) => screen.getByRole<HTMLButtonElement>('button', { name }));
    expect(chips.map((c) => c.type)).toEqual(['button', 'button', 'button']);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);

    await fireEvent.click(chips[2]);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
  });

  /**
   * MICA-412: `formatRelativeTime` called bare reads the locale once, so the row went on
   * saying "5m ago" after the phone switched to German. Passed `$t`, it re-formats.
   */
  it('re-formats the install time when the locale changes', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000 - 1_000).toISOString();
    render(InstalledList, props([app('notes', fiveMinutesAgo)]));
    expect(screen.getByText('5m ago')).toBeTruthy();

    locale.set('de');
    expect(await screen.findByText('vor 5 Min.')).toBeTruthy();
  });
});
