// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../host/registerFacets';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import Shell from './Shell.svelte';
import { closeAllApps } from './state/navigation';
import { openDevice } from './state/phoneOpen';
import { activeDevice, setActiveDevice } from './state/device';
import { chargeOf } from './state/charge';
import { isLocked } from './state/lockScreen';
import { get } from 'svelte/store';
import type { DeviceId } from '@mica/shared/devices';

/**
 * A power-on shows the boot screen first, never the phone behind it (MICA-236, the owner's
 * "it loads the phone first, then the loading screen, then the phone again").
 *
 * The boot screen used to sit beside the frame, where it could not ride the frame's fly-in, so
 * it waited the 500 ms flight out transparent: the whole phone flew in and showed, then the
 * black faded in over it, then out again. It is now the last layer of the frame's own screen
 * and black from the flush that puts the frame on the page.
 *
 * jsdom paints nothing, so this pins what decides the paint: in the same synchronous flush that
 * creates the frame (or brings a dead phone's screen back), the boot screen is inside that
 * frame, has no delay or fade-in on its black, and nothing else in the screen is stacked over
 * it. That it is opaque in a real Chromium, and when, is the e2e suite's to see.
 */

/** jsdom has no Web Animations; the frame's fly-in finishes at once. See `Shell.test.ts`. */
Element.prototype.animate = vi.fn(() => {
  const animation = {
    cancel: () => {},
    finish: () => {},
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0, progress: 1 }) },
    set onfinish(handler: (() => void) | null) {
      if (handler) queueMicrotask(handler);
    }
  };
  return animation as unknown as Animation;
});

/** What the client's `SendNUIMessage` delivers: a `message` with no `source`. */
const setVisible = (visible: boolean) => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { action: 'setVisible', data: { device: get(activeDevice), visible } }
    })
  );
  flushSync();
};

/** The `z-*` utility an element stacks at, or its inline `z-index`; `null` when it has none. */
const zOf = (el: Element): number | null => {
  const inline = (el as HTMLElement).style?.zIndex;
  if (inline) return Number(inline);
  const match = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(el.getAttribute('class') ?? '');
  return match ? Number(match[1] ?? match[2]) : null;
};

/**
 * Everything the phone shows is covered: the boot screen is in `device`'s frame, the last child
 * of its screen, black with nothing to wait for, and no layer in that screen is stacked above it.
 * The content area is not a stacking context, so every app's and widget's own `z-*` competes
 * here too, which is why this reads the whole screen rather than a list of known layers.
 */
const expectCovered = (container: HTMLElement, device: DeviceId) => {
  const frame = container.querySelector(`[data-device-frame="${device}"]`);
  expect(frame, 'the frame is up').not.toBeNull();
  const boot = frame!.querySelector<HTMLElement>('[data-testid="boot-screen"]');
  expect(boot, 'the boot screen is inside the frame, so it rides the fly-in').not.toBeNull();
  expect(container.querySelectorAll('[data-testid="boot-screen"]')).toHaveLength(1);
  expect(boot!.dataset.phase).toBe('boot');
  expect(boot!.style.animationDelay, 'its black waits for nothing').toBe('');
  expect(boot!.style.animationDuration, 'and does not fade in').toBe('');
  expect(boot!.className).toMatch(/(^|\s)bg-black(\s|$)/);

  const screen = frame!.querySelector(`[data-testid="${device}-screen"]`);
  expect(screen?.lastElementChild, 'the last layer of the screen').toBe(boot);
  const bootZ = zOf(boot!);
  expect(bootZ).not.toBeNull();
  const layers = [...screen!.querySelectorAll('*')].filter(
    (el) => !boot!.contains(el) && zOf(el) !== null
  );
  // The home indicator's `z-60` at the least: a sweep that read no layer would prove nothing.
  expect(layers.length, "the sweep saw the screen's layers").toBeGreaterThan(0);
  const above = layers.filter((el) => zOf(el)! > bootZ!);
  expect(above, 'nothing in the screen stacks over it').toEqual([]);
};

const homeShown = (container: HTMLElement) =>
  container.querySelector('[data-testid="home-layer"]') !== null &&
  container.querySelector('[data-testid="status-bar-row"]') !== null;

/**
 * The boot has ended, and the phone is what is left. Real timers: the boot ends 1600 ms after
 * an open at the latest (the fly-in, then the ceiling), so 5 s is headroom for a loaded runner,
 * and two of these fit the 20 s `testTimeout` with room to spare.
 */
const expectBootEnded = async (container: HTMLElement) => {
  await waitFor(
    () => {
      expect(container.querySelector('[data-testid="boot-screen"]')).toBeNull();
      expect(get(isLocked)).toBe(false);
      expect(homeShown(container)).toBe(true);
    },
    { timeout: 5000 }
  );
};

afterEach(() => {
  cleanup();
  closeAllApps();
  openDevice.set(null);
  chargeOf.phone.set(100);
  chargeOf.tablet.set(100);
  setActiveDevice('phone');
});

describe('a power-on shows the boot screen, never the phone behind it', () => {
  it.each(['phone', 'tablet'] as const)(
    "covers the %s's screen from the flush that opens it, then shows the phone",
    async (device) => {
      setActiveDevice(device);
      // The browser opens itself on mount, the session's first open: a power-on.
      const view = render(Shell);
      flushSync();
      expectCovered(view.container, device);

      await expectBootEnded(view.container);
    }
  );

  it('covers a revived phone in the same flush that brings its screen back', async () => {
    const view = render(Shell);
    await expectBootEnded(view.container);

    chargeOf.phone.set(0);
    flushSync();
    expect(view.container.querySelector('[data-testid="home-layer"]')).toBeNull();

    chargeOf.phone.set(30);
    flushSync();
    expect(view.container.querySelector('[data-testid="home-layer"]')).not.toBeNull();
    expectCovered(view.container, 'phone');

    await expectBootEnded(view.container);
  });

  /**
   * The game's path: the page is up, and the client's `setVisible` raises a phone that has a
   * power-on due. Here, one that died and was charged back while it was down, so its next open
   * boots; the session's first open in game takes the same message and the same flush.
   */
  it("covers the screen from the flush that answers the client's setVisible", async () => {
    const view = render(Shell);
    await expectBootEnded(view.container);

    chargeOf.phone.set(0);
    setVisible(false);
    await waitFor(() => expect(view.container.querySelector('main')).toBeNull());
    chargeOf.phone.set(30);

    setVisible(true);
    expectCovered(view.container, 'phone');

    await expectBootEnded(view.container);
  });

  it('does not boot an ordinary reopen', async () => {
    const view = render(Shell);
    await expectBootEnded(view.container);

    setVisible(false);
    await waitFor(() => expect(view.container.querySelector('main')).toBeNull());
    setVisible(true);
    expect(view.container.querySelector('[data-device-frame="phone"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="boot-screen"]')).toBeNull();
  });
});
