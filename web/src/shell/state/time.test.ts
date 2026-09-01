// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { time, is24Hour, formattedTime } from './time';
import { get } from 'svelte/store';
import { useStorage } from '../../../../sdk/host/useStorage';

describe('time store', () => {
  it('formats time in 12-hour format by default', () => {
    time.set({ hours: 14, minutes: 30 });
    is24Hour.set(false);

    expect(get(formattedTime)).toBe('2:30 PM');
  });

  it('formats time in 24-hour format when enabled', () => {
    time.set({ hours: 14, minutes: 30 });
    is24Hour.set(true);

    expect(get(formattedTime)).toBe('14:30');
  });

  it('handles midnight formatting in 12-hour format', () => {
    time.set({ hours: 0, minutes: 5 });
    is24Hour.set(false);

    expect(get(formattedTime)).toBe('12:05 AM');
  });

  it('writes the 24-hour preference to storage so a reload keeps it', () => {
    is24Hour.set(true);
    expect(useStorage('settings').getItem<boolean>('is24Hour')).toBe(true);
  });
});
