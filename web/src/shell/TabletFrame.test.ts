// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against — in-process, because a
 * unit test stands in for the shell.
 */
import '../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import TabletFrame from './TabletFrame.svelte';
import { charge } from './state/charge';
import { setActiveDevice } from './state/device';

// jsdom has no Web Animations API and Svelte's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const noopSnippet = (() => {}) as never;

/**
 * The tablet's body is the chrome `shared/devices.ts` says it has and nothing the phone
 * has that it does not (MICA-259).
 */
describe('TabletFrame', () => {
  beforeEach(() => {
    setActiveDevice('tablet');
    charge.set(100);
  });

  it('is the design size from the table, with the shared chrome inside', () => {
    const { getByTestId, getByRole } = render(TabletFrame, { props: { children: noopSnippet } });
    const frame = getByTestId('tablet-frame');
    expect(frame.style.width).toBe('1280px');
    expect(frame.style.height).toBe('800px');
    expect(frame.dataset.deviceFrame).toBe('tablet');
    expect(frame.className).toMatch(/(^|\s)border-\[12px\](\s|$)/);
    expect(frame.className).toMatch(/\brounded-frame-outer-tablet\b/);
    expect(getByRole('button', { name: 'Open notification shade' })).toBeTruthy();
    expect(getByRole('button', { name: 'Return to home screen' })).toBeTruthy();
  });

  it('has no hole-punch, no hardware buttons and no lock screen', () => {
    const { queryByTestId, queryByTitle } = render(TabletFrame, {
      props: { children: noopSnippet }
    });
    expect(queryByTestId('camera-cutout')).toBeNull();
    expect(queryByTestId('phone-frame')).toBeNull();
    expect(queryByTitle('Power / Screen Off')).toBeNull();
  });

  it('paints the dead-battery takeover and drops the status bar when the battery is flat', () => {
    charge.set(0);
    const { queryByRole, getByText } = render(TabletFrame, { props: { children: noopSnippet } });
    expect(queryByRole('button', { name: 'Open notification shade' })).toBeNull();
    expect(getByText('Battery Low')).toBeTruthy();
  });
});
