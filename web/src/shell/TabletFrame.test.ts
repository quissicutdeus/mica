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
import { isLocked } from './state/lockScreen';

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
const props = () => ({ onClose: () => {}, children: noopSnippet });

/**
 * The tablet's body is the chrome `shared/devices.ts` says it has and nothing the phone
 * has that it does not (MICA-259).
 */
describe('TabletFrame', () => {
  beforeEach(() => {
    setActiveDevice('tablet');
    charge.set(100);
    isLocked.set(false);
  });

  it('is the design size from the table, with the shared chrome inside', () => {
    const { getByTestId, getByRole } = render(TabletFrame, { props: props() });
    const frame = getByTestId('tablet-frame');
    expect(frame.style.width).toBe('1280px');
    expect(frame.style.height).toBe('800px');
    expect(frame.dataset.deviceFrame).toBe('tablet');
    expect(frame.className).toMatch(/(^|\s)border-\[12px\](\s|$)/);
    expect(frame.className).toMatch(/\brounded-frame-outer-tablet\b/);
    expect(getByRole('button', { name: 'Open notification shade' })).toBeTruthy();
    expect(getByRole('button', { name: 'Return to home screen' })).toBeTruthy();
  });

  it('has no hole-punch, and no lock screen while unlocked', () => {
    const { queryByTestId, queryByRole } = render(TabletFrame, { props: props() });
    expect(queryByTestId('camera-cutout')).toBeNull();
    expect(queryByTestId('phone-frame')).toBeNull();
    expect(queryByRole('dialog', { name: 'Lock screen' })).toBeNull();
  });

  it('draws the lock screen in place of the status bar and the apps when locked (MICA-264)', () => {
    isLocked.set(true);
    const children = vi.fn();
    const { getByRole, queryByRole, queryByText } = render(TabletFrame, {
      props: { onClose: () => {}, children: children as never }
    });
    expect(getByRole('dialog', { name: 'Lock screen' })).toBeTruthy();
    expect(getByRole('button', { name: 'Unlock' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Open notification shade' })).toBeNull();
    expect(children).not.toHaveBeenCalled();
    // The tablet places no calls (`shared/devices.ts`), so there is no emergency call to offer.
    expect(queryByText('Emergency Call')).toBeNull();
  });

  it('shows the dead battery, not the lock screen, when both apply', () => {
    isLocked.set(true);
    charge.set(0);
    const { queryByRole, getByText } = render(TabletFrame, { props: props() });
    expect(queryByRole('dialog', { name: 'Lock screen' })).toBeNull();
    expect(getByText('Battery Low')).toBeTruthy();
  });

  it('carries the power and volume keys, and power lowers the device', () => {
    const onClose = vi.fn();
    const { getByTitle } = render(TabletFrame, { props: { onClose, children: noopSnippet } });
    expect(getByTitle('Volume Up')).toBeTruthy();
    expect(getByTitle('Volume Down')).toBeTruthy();

    getByTitle('Power / Screen Off').click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables the volume keys on a flat battery, the way the phone does', () => {
    charge.set(0);
    const { getByTitle } = render(TabletFrame, { props: props() });
    expect((getByTitle('Volume Up') as HTMLButtonElement).disabled).toBe(true);
  });

  it('paints the dead-battery takeover and drops the status bar when the battery is flat', () => {
    charge.set(0);
    const { queryByRole, getByText } = render(TabletFrame, { props: props() });
    expect(queryByRole('button', { name: 'Open notification shade' })).toBeNull();
    expect(getByText('Battery Low')).toBeTruthy();
  });
});
