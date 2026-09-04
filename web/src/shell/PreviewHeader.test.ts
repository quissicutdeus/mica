// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import PreviewHeader from './PreviewHeader.svelte';
import { setActiveDevice } from './state/device';
import { ALL_DEVICES, DEVICES } from '@mica/shared/devices';

/**
 * The preview's own chrome. Everything asserted here is about not disturbing what is
 * already on the page: the suite reaches for buttons by name, and the device's own
 * controls have to keep winning.
 */
describe('PreviewHeader', () => {
  beforeEach(() => {
    setActiveDevice('phone');
  });

  it('lists every device in the table, as links rather than buttons', () => {
    const { getAllByRole, queryAllByRole } = render(PreviewHeader, {
      props: { onopen: () => {} }
    });

    const links = getAllByRole('link');
    expect(links.map((a) => a.textContent?.trim())).toEqual(
      ALL_DEVICES.map((id) => DEVICES[id].label)
    );

    // Role `link`, never `button`: `e2e/apps/phone.spec.ts` opens the Phone app with the
    // first button whose text contains "Phone", and a header entry labelled the same way
    // would take that click if it were one.
    expect(queryAllByRole('button')).toHaveLength(0);
  });

  it('carries a real href per device, so a demo link can be copied or opened in a tab', () => {
    const { getByRole } = render(PreviewHeader, { props: { onopen: () => {} } });

    expect(getByRole('link', { name: 'Phone' }).getAttribute('href')).toBe('./');
    expect(getByRole('link', { name: 'Tablet' }).getAttribute('href')).toBe('./?device=tablet');
  });

  it('answers a plain click in place and leaves the address bar matching', () => {
    const onopen = vi.fn();
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    const { getByRole } = render(PreviewHeader, { props: { onopen } });

    getByRole('link', { name: 'Tablet' }).click();

    expect(onopen).toHaveBeenCalledWith('tablet');
    expect(replaceState).toHaveBeenCalledWith(null, '', './?device=tablet');
    replaceState.mockRestore();
  });

  it('marks the device that is up, and moves the mark when it changes', async () => {
    const { getByRole } = render(PreviewHeader, { props: { onopen: () => {} } });
    expect(getByRole('link', { name: 'Phone' }).getAttribute('aria-current')).toBe('page');
    expect(getByRole('link', { name: 'Tablet' }).getAttribute('aria-current')).toBeNull();

    setActiveDevice('tablet');
    await Promise.resolve();

    expect(getByRole('link', { name: 'Tablet' }).getAttribute('aria-current')).toBe('page');
    expect(getByRole('link', { name: 'Phone' }).getAttribute('aria-current')).toBeNull();
  });

  it('is not a heading, so a closed device still leaves the page without one', () => {
    const { queryByRole } = render(PreviewHeader, { props: { onopen: () => {} } });
    // `defects.spec.ts` and `keybinds.spec.ts` both assert no `h1` once the device is
    // down; the launcher's wordmark is the page's heading and this mark is not.
    expect(queryByRole('heading')).toBeNull();
  });
});
