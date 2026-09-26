// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import BootScreen from './BootScreen.svelte';
import { powerState } from './state/power';
import { ownerConfig } from './state/ownerConfig';
import { setActiveDevice } from './state/device';

/** MICA-236: what the overlay draws, and that a dead logo never leaves a broken image. */

const LOGO = 'https://cfx-nui-mica/branding/logo.png';
const boot = () => powerState.set({ phase: 'boot', delayMs: 0 });

beforeEach(() => {
  powerState.set({ phase: 'idle', delayMs: 0 });
  ownerConfig.update((c) => ({ ...c, brandLogo: null }));
  setActiveDevice('phone');
});
afterEach(cleanup);

describe('BootScreen', () => {
  it('renders nothing while idle', () => {
    const { queryByTestId } = render(BootScreen);
    expect(queryByTestId('boot-screen')).toBeNull();
  });

  it('is aria-hidden and never takes input', () => {
    boot();
    const { getByTestId } = render(BootScreen);
    const el = getByTestId('boot-screen');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.className).toContain('pointer-events-none');
  });

  it('draws the micaOS mark when there is no owner logo', () => {
    boot();
    const { getByTestId, container } = render(BootScreen);
    expect(getByTestId('boot-mark').getAttribute('aria-label')).toBe('micaOS logo');
    expect(container.querySelector('img')).toBeNull();
  });

  it("draws the owner's logo, with alt text, when there is one", () => {
    ownerConfig.update((c) => ({ ...c, brandLogo: LOGO }));
    boot();
    const { container, queryByTestId } = render(BootScreen);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(LOGO);
    expect(img?.getAttribute('alt')).toBe('micaOS logo');
    expect(queryByTestId('boot-mark')).toBeNull();
  });

  it('falls back to the mark when the logo fails to load, with no broken image left', async () => {
    ownerConfig.update((c) => ({ ...c, brandLogo: LOGO }));
    boot();
    const { container, getByTestId } = render(BootScreen);
    await fireEvent.error(container.querySelector('img') as HTMLImageElement);
    await tick();
    expect(container.querySelector('img')).toBeNull();
    expect(getByTestId('boot-mark')).toBeTruthy();
  });

  it('insets by the device bezel so it stays inside the screen', () => {
    boot();
    const { getByTestId } = render(BootScreen);
    expect(getByTestId('boot-screen').getAttribute('style')).toContain('inset: 8px');
  });
});
