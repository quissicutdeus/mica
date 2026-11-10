// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import BootScreen from './BootScreen.svelte';
import { BOOT_EXIT_MS, BOOT_IN_MS, POWER_OFF_MS, powerState } from './state/power';
import { ownerConfig } from './state/ownerConfig';

/** MICA-236: what the overlay draws, and that a dead logo never leaves a broken image. */

const LOGO = 'https://cfx-nui-mica/branding/logo.png';
const boot = () => powerState.set({ phase: 'boot', delayMs: 0 });

beforeEach(() => {
  powerState.set({ phase: 'idle', delayMs: 0 });
  ownerConfig.update((c) => ({ ...c, brandLogo: null }));
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

  /**
   * The mark is `public/mica.svg` inline, whose sheet, gradients and clip-path are reached
   * by `href="#id"` and `url(#id)`. Inline ids are document-global, so each is prefixed;
   * and a reference that names no id paints nothing, with no error anywhere, so every one
   * is checked against the ids the mark itself defines.
   */
  it('draws the mark with prefixed ids and no dangling reference', () => {
    boot();
    const { getByTestId } = render(BootScreen);
    const mark = getByTestId('boot-mark');
    const ids = [...mark.querySelectorAll('[id]')].map((el) => el.id).sort();
    expect(ids).toEqual([
      'mica-boot-b',
      'mica-boot-c',
      'mica-boot-f',
      'mica-boot-m',
      'mica-boot-s'
    ]);

    const REF: Record<string, RegExp> = {
      fill: /^url\(#(.+)\)$/,
      'clip-path': /^url\(#(.+)\)$/,
      href: /^#(.+)$/
    };
    const refs = [...mark.querySelectorAll('[fill], [clip-path], [href]')].flatMap((el) =>
      Object.entries(REF)
        .map(([attr, pattern]) => pattern.exec(el.getAttribute(attr) ?? '')?.[1])
        .filter((ref): ref is string => ref !== undefined)
    );
    // Ten references: four uses of the sheet (three drawn, one in the clip), two inherited
    // gradients, three fills, one clip-path. Every one resolves inside the mark, and every
    // id is used.
    expect(refs).toHaveLength(10);
    expect([...new Set(refs)].sort()).toEqual(ids);
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

  /**
   * A power-on shows the boot screen and never the phone behind it, so a boot's black has no
   * fade-in and waits for nothing: only the logo waits out the open's fly-in. It used to be
   * the backdrop that waited, transparent, and the whole phone flew in and showed first.
   * MICA-450: it fades out only when `power.ts` says it leaves, at once.
   */
  it('puts a boot up black at once, lets only the logo wait, and fades out when it leaves', async () => {
    powerState.set({ phase: 'boot', delayMs: 500 });
    const { getByTestId } = render(BootScreen);
    const el = getByTestId('boot-screen');
    const logo = el.firstElementChild as HTMLElement;
    expect(el.className).toMatch(/(^|\s)bg-black(\s|$)/);
    expect(el.style.animationDelay, 'the backdrop never waits').toBe('');
    expect(el.style.animationDuration, 'nor fades in').toBe('');
    expect(el.hasAttribute('data-leaving')).toBe(false);
    expect(logo.style.animationDelay).toBe('500ms');
    expect(logo.style.animationDuration).toBe(`400ms, ${BOOT_IN_MS}ms`);

    powerState.set({ phase: 'boot', delayMs: 500, leaving: true });
    await tick();
    expect(el.getAttribute('data-leaving')).toBe('true');
    expect(el.style.animationDuration).toBe(`${BOOT_EXIT_MS}ms`);
    expect(el.style.animationDelay).toBe('');
    // The logo keeps the open's delay, so the fade-out cannot retime its entrance.
    expect(logo.style.animationDelay).toBe('500ms');
  });

  it('runs the power-off screen for its fixed time', () => {
    powerState.set({ phase: 'off', delayMs: 0 });
    const { getByTestId } = render(BootScreen);
    expect(getByTestId('boot-screen').style.animationDuration).toBe(`${POWER_OFF_MS}ms`);
  });

  /**
   * It covers the box it is placed in, at the top layer there. Which box is the frames' to
   * decide: their screens, so it is clipped to the screen and rides the fly-in
   * (`Shell.boot.test.ts`). It used to inset itself by the bezel from beside the frame.
   */
  it('fills the box it is placed in, at the top layer', () => {
    boot();
    const { getByTestId } = render(BootScreen);
    const el = getByTestId('boot-screen');
    expect(el.className).toMatch(/(^|\s)absolute(\s|$)/);
    for (const edge of ['inset-x-0', 'top-0', 'bottom-0']) {
      expect(el.className).toMatch(new RegExp(`(^|\\s)${edge}(\\s|$)`));
    }
    // Not the resident-app slot's shape, which `Shell.test.ts` and specs select by.
    expect(el.matches('div.absolute.inset-0')).toBe(false);
    expect(el.className).toMatch(/(^|\s)z-80(\s|$)/);
    expect(el.style.inset).toBe('');
  });
});
