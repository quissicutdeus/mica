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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  displaySize,
  fitScaleFor,
  frameMargin,
  isSizeLimited,
  marginFor,
  observeViewport,
  phoneBox,
  phoneScale,
  scaleForSize,
  viewportSize,
  DISPLAY_SIZE_DEFAULT,
  MARGIN_LARGE,
  MARGIN_SMALL,
  MAX_SCALE,
  MIN_SCALE,
  PHONE_HEIGHT,
  PHONE_WIDTH,
  STATUS_BAR_MAX_NOTIFICATION_ICONS,
  statusBarIconCap
} from './display';
import { DEVICES } from '@mica/shared/devices';

describe('the phone is one ratio at many sizes', () => {
  beforeEach(() => {
    displaySize.set(DISPLAY_SIZE_DEFAULT);
    viewportSize.set({ width: 1920, height: 1080 });
  });

  it('draws the design size at the shipped default when the window has room for the whole range', () => {
    // 1440 tall: the fit exceeds MAX_SCALE, so the range is the full one and the midpoint
    // is exactly 1 — the size the phone has always been drawn at.
    viewportSize.set({ width: 1920, height: 1440 });
    expect(scaleForSize(DISPLAY_SIZE_DEFAULT)).toBe(1);
    expect(get(phoneBox)).toEqual({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  });

  it('maps the slider over the whole range, ends included', () => {
    expect(scaleForSize(0)).toBe(MIN_SCALE);
    expect(scaleForSize(100)).toBe(MAX_SCALE);
  });

  it('treats a stored value it cannot use as the default', () => {
    // `usePersisted` runs `sanitize` on every write as well as on the value read at
    // startup, so a hand-edited key cannot make the phone 4000 pixels tall.
    displaySize.set(9999);
    expect(get(displaySize)).toBe(DISPLAY_SIZE_DEFAULT);
    displaySize.set(Number.NaN);
    expect(get(displaySize)).toBe(DISPLAY_SIZE_DEFAULT);
    displaySize.set(-1);
    expect(get(displaySize)).toBe(DISPLAY_SIZE_DEFAULT);
  });

  it('keeps the aspect ratio at every size, which is the point of scaling rather than reflowing', () => {
    const design = PHONE_WIDTH / PHONE_HEIGHT;
    for (const size of [0, 25, 50, 75, 100]) {
      displaySize.set(size);
      const box = get(phoneBox);
      expect(box.width / box.height).toBeCloseTo(design, 10);
    }
  });
});

describe('fitting the window', () => {
  beforeEach(() => {
    displaySize.set(DISPLAY_SIZE_DEFAULT);
  });

  it('shrinks to fit a viewport shorter than the phone — the defect this fixes', () => {
    // A phone browser in portrait: 850px of phone plus margins does not fit in 664px.
    viewportSize.set({ width: 390, height: 664 });
    const scale = get(phoneScale);
    expect(scale).toBeLessThan(1);
    expect(get(phoneBox).height).toBeLessThanOrEqual(664 - MARGIN_SMALL * 2);
    expect(get(phoneBox).width).toBeLessThanOrEqual(390 - MARGIN_SMALL * 2);
    expect(get(isSizeLimited)).toBe(true);
  });

  it('leaves a window with room for the whole range entirely to the setting', () => {
    viewportSize.set({ width: 1920, height: 1440 });
    expect(get(phoneScale)).toBe(1);
    expect(get(isSizeLimited)).toBe(false);
  });

  it('moves at every slider position, on a window that cannot fit the top of the range', () => {
    // The defect. The slider used to map onto a fixed 0.6-1.4 and get clamped afterwards,
    // so on a ~950px window — a maximised browser at 1080p — the fit landed at almost
    // exactly 1 and **50 through 100 all rendered identically**. Half the control did
    // nothing, which is what it was reported as: "anything at 50% and above is max size".
    viewportSize.set({ width: 1920, height: 950 });

    const seen = [0, 25, 50, 75, 100].map((size) => {
      displaySize.set(size);
      return get(phoneScale);
    });

    expect(new Set(seen).size).toBe(seen.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it('never draws larger than the window allows, at any setting', () => {
    viewportSize.set({ width: 1920, height: 950 });
    displaySize.set(100);
    const margin = get(frameMargin);
    expect(get(phoneBox).height).toBeLessThanOrEqual(950 - margin * 2);
  });

  it('gives up margin before it gives up phone', () => {
    // The large margin costs 96px of height and the phone needs 850 — so on a window with
    // 900, those 96px are the difference between reaching design size and not. Breathing
    // room is a nicety; drawing the phone at the requested size is the point.
    expect(marginFor(1920, 900)).toBeLessThan(MARGIN_LARGE);
    expect(marginFor(1920, 900)).toBeGreaterThanOrEqual(MARGIN_SMALL);
  });

  it('never lets a smaller window allow a larger phone', () => {
    // A two-step margin rule did exactly that: a 900px window crossed the threshold and
    // got 32px back while a 950px one kept paying the full 96.
    let previous = 0;
    for (const height of [700, 800, 850, 900, 950, 1000, 1080, 1200, 1440]) {
      const scale = fitScaleFor({ width: 1920, height });
      expect(scale).toBeGreaterThanOrEqual(previous);
      previous = scale;
    }
  });

  it('stops at MAX_SCALE however much room there is', () => {
    displaySize.set(100);
    viewportSize.set({ width: 3840, height: 2160 });
    expect(get(phoneScale)).toBe(MAX_SCALE);
  });

  it('pads by exactly what the fit subtracted', () => {
    viewportSize.set({ width: 390, height: 664 });
    expect(get(frameMargin)).toBe(MARGIN_SMALL);
    viewportSize.set({ width: 1920, height: 1080 });
    expect(get(frameMargin)).toBe(MARGIN_LARGE);
    // Nothing above phone height plus two large margins should pay less than the full one.
    expect(marginFor(639, 2000)).toBe(MARGIN_SMALL);
  });

  it('does not clamp against a viewport nothing has measured yet', () => {
    // jsdom and the first render before `observeViewport` both report zero, and a fit of
    // zero is an invisible phone.
    expect(fitScaleFor({ width: 0, height: 0 })).toBe(MAX_SCALE);
  });
});

describe('following the window', () => {
  let stop: () => void;
  const resize = (width: number, height: number) => {
    window.innerWidth = width;
    window.innerHeight = height;
    window.dispatchEvent(new Event('resize'));
  };

  beforeEach(() => {
    stop = observeViewport();
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = '';
  });

  it('measures on start and on every resize', () => {
    resize(800, 900);
    expect(get(viewportSize)).toEqual({ width: 800, height: 900 });
  });

  it('ignores the height an on-screen keyboard steals, but not a rotation', () => {
    resize(390, 800);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    // Chrome on Android shrinks the layout viewport when the keyboard opens. Honouring it
    // halves the phone the moment you tap a message field.
    resize(390, 420);
    expect(get(viewportSize)).toEqual({ width: 390, height: 800 });

    // Width still tracks, so turning the device while typing is not ignored.
    resize(800, 420);
    expect(get(viewportSize).width).toBe(800);

    input.blur();
    resize(390, 800);
    expect(get(viewportSize)).toEqual({ width: 390, height: 800 });
  });
});

/**
 * MICA-258: the phone's numbers come from the device table, and the status-bar cap is
 * derived from them rather than restated. The cap's value is pinned because the arithmetic
 * behind it was measured in a browser: a change that moves 3 is a change to the bar, not to
 * the function.
 */
describe('the phone is one device of the table', () => {
  it('draws the frame the device table declares', () => {
    expect(PHONE_WIDTH).toBe(DEVICES.phone.frame.width);
    expect(PHONE_HEIGHT).toBe(DEVICES.phone.frame.height);
  });

  it('caps the status-bar icons at three on the phone, as measured', () => {
    expect(STATUS_BAR_MAX_NOTIFICATION_ICONS).toBe(3);
    expect(statusBarIconCap(400, true)).toBe(3);
  });

  it('fits a second frame by its own size, on the same window (MICA-259)', () => {
    const window = { width: 1280, height: 960 };
    // The phone fits at design size here with room to spare; the tablet does not.
    expect(fitScaleFor(window)).toBeGreaterThan(1);
    expect(fitScaleFor(window, DEVICES.tablet.frame)).toBeLessThan(1);
    // And the margin yields for the tablet's height, not the phone's.
    expect(marginFor(1920, 900, DEVICES.tablet.frame)).toBe(MARGIN_LARGE);
    expect(marginFor(1920, 900, DEVICES.phone.frame)).toBe(Math.floor((900 - 850) / 2));
  });

  it('gives a frame with no hole-punch more room, up to the readable ceiling', () => {
    const tablet = DEVICES.tablet;
    const cap = statusBarIconCap(tablet.frame.width, tablet.chrome.holePunch);
    expect(cap).toBeGreaterThan(STATUS_BAR_MAX_NOTIFICATION_ICONS);
    expect(cap).toBeLessThanOrEqual(8);
    // Narrow enough that nothing fits still answers a number, never a negative one.
    expect(statusBarIconCap(100, false)).toBe(0);
  });
});
