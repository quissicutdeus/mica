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
  PHONE_WIDTH
} from './display';

describe('the phone is one ratio at many sizes', () => {
  beforeEach(() => {
    displaySize.set(DISPLAY_SIZE_DEFAULT);
    viewportSize.set({ width: 1920, height: 1080 });
  });

  it('draws the design size at the shipped default, so nothing moves for an existing player', () => {
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

  it('leaves a roomy window entirely to the setting', () => {
    viewportSize.set({ width: 1920, height: 1080 });
    expect(get(phoneScale)).toBe(1);
    expect(get(isSizeLimited)).toBe(false);
  });

  it('caps the setting rather than the window when both have room', () => {
    displaySize.set(100);
    viewportSize.set({ width: 3840, height: 2160 });
    expect(get(phoneScale)).toBe(MAX_SCALE);
  });

  it('pads by exactly what the fit subtracted', () => {
    viewportSize.set({ width: 390, height: 664 });
    expect(get(frameMargin)).toBe(MARGIN_SMALL);
    viewportSize.set({ width: 1920, height: 1080 });
    expect(get(frameMargin)).toBe(MARGIN_LARGE);
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
