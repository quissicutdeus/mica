// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { tick } from 'svelte';
import { render } from '@testing-library/svelte';
import { locale } from '../../../../sdk/i18n';
import Clock from './Clock.svelte';
import { time, is24Hour } from '../state/time';

/** MICA-245: the Clock widget follows the status bar's clock and the phone's locale. */

beforeEach(() => {
  time.set({ hours: 14, minutes: 5 });
  is24Hour.set(true);
  locale.set('en');
});

describe('Clock widget', () => {
  it.each(['2x1', '2x2'] as const)('renders time and date at %s', (size) => {
    const { getByTestId } = render(Clock, { size });
    expect(getByTestId('widget-clock-time').textContent).toBe('14:05');
    expect(getByTestId('widget-clock-date').textContent?.length).toBeGreaterThan(3);
    expect(getByTestId('widget-clock').dataset.size).toBe(size);
  });

  it('updates when the clock does, and follows the 12-hour setting', async () => {
    const { getByTestId } = render(Clock, { size: '2x2' });
    time.set({ hours: 23, minutes: 59 });
    await tick();
    expect(getByTestId('widget-clock-time').textContent).toBe('23:59');
    is24Hour.set(false);
    await tick();
    expect(getByTestId('widget-clock-time').textContent).toMatch(/11:59\s?PM/i);
  });

  it('formats the date under the phone locale', async () => {
    const { getByTestId } = render(Clock, { size: '2x2' });
    const en = getByTestId('widget-clock-date').textContent;
    locale.set('de');
    await tick();
    expect(getByTestId('widget-clock-date').textContent).not.toBe(en);
  });
});
