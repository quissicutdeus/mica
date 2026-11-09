// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { get } from 'svelte/store';
import Shell from './Shell.svelte';
import { closeAllApps } from './state/navigation';
import { openDevice } from './state/phoneOpen';
import { isLocked } from './state/lockScreen';
import { activeDevice, setActiveDevice } from './state/device';
import * as fetchNuiModule from '../nui/fetchNui';
import * as frameShownModule from './state/frameShown';

/**
 * The client holds NUI focus on an open until the page says the frame is on it, and puts the
 * device down if that never comes (MICA-475). So the shell answers the client's own
 * `setVisible(true)`, for the device it named, once that device's frame is in the document. It
 * never answers a hide, the browser's own open on mount, or a frame that failed to mount.
 *
 * Every negative here is asserted at a known point, never after a wait: Svelte's flush has run,
 * and every answer the shell started has been sent or dropped.
 */

/** The phone's frame, real unless a case makes it throw while mounting. */
const mount = vi.hoisted(() => ({ fails: false }));
vi.mock('./PhoneFrame.svelte', async (importOriginal) => {
  const real = await importOriginal<{ default: (...args: unknown[]) => unknown }>();
  return {
    default: (...args: unknown[]) => {
      if (mount.fails) throw new Error('PhoneFrame failed to mount');
      return real.default(...args);
    }
  };
});

/** jsdom has no Web Animations; the frame's fly-in and fly-out finish at once. See `Shell.test.ts`. */
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
const send = (data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data: { action: 'setVisible', data } }));
};

const realFetchNui = fetchNuiModule.fetchNui;
const realAcknowledge = frameShownModule.acknowledgeFrameShown;

/** Each `frameShown` sent, and whether that device's frame was in the document when it went. */
let answers: { data: unknown; drawn: boolean }[] = [];
/** Every answer the shell started, so a case can wait for all of them to finish. */
let started: Promise<void>[] = [];
/** Each `setVisible` show the page received, from the dev harness's seed or from a case. */
let shows: unknown[] = [];

const countShows = (event: MessageEvent) => {
  const { action, data } = (event.data ?? {}) as { action?: string; data?: unknown };
  if (action !== 'setVisible') return;
  if (data === true || (data as { visible?: unknown } | null)?.visible === true) shows.push(data);
};

/** Svelte's flush, then every answer started so far: past this, nothing more is coming. */
const settleAnswers = async () => {
  await tick();
  await Promise.all(started);
};

/**
 * Rendered, past the lock, and past the dev harness's seed. A browser boot gets exactly one
 * `setVisible`, the seed standing in for the client; the shell's own open on mount is not one.
 */
const renderOpen = async () => {
  const view = render(Shell);
  await waitFor(() => expect(get(isLocked)).toBe(false));
  await waitFor(() => expect(view.container.querySelector('main')).not.toBeNull());
  await waitFor(() => expect(shows).toHaveLength(1));
  await settleAnswers();
  return view;
};

beforeEach(() => {
  answers = [];
  started = [];
  shows = [];
  mount.fails = false;
  window.addEventListener('message', countShows);
  // Passed through, so the browser mock answers it as it would in a dev browser.
  vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((eventName, data, options) => {
    if (eventName === 'frameShown') {
      const device = (data as { device?: unknown }).device;
      const frame = document.querySelector(`[data-device-frame="${String(device)}"]`);
      answers.push({ data, drawn: frame?.isConnected === true });
    }
    return realFetchNui(eventName, data, options);
  });
  vi.spyOn(frameShownModule, 'acknowledgeFrameShown').mockImplementation((device, frameOf) => {
    const answer = realAcknowledge(device, frameOf);
    started.push(answer);
    return answer;
  });
});

afterEach(() => {
  window.removeEventListener('message', countShows);
  vi.restoreAllMocks();
  mount.fails = false;
  cleanup();
  closeAllApps();
  openDevice.set(null);
  setActiveDevice('phone');
});

describe("Shell answers the client's setVisible once the frame is on the page (MICA-475)", () => {
  it('answers each show for the phone, and never a hide or its own open', async () => {
    await renderOpen();
    expect(answers, "the seed's show, and nothing for the shell's own open").toEqual([
      { data: { device: 'phone' }, drawn: true }
    ]);

    send(false);
    flushSync();
    await settleAnswers();
    expect(answers, 'a hide is not answered').toHaveLength(1);

    send(true);
    flushSync();
    expect(answers, 'not on receipt').toHaveLength(1);
    await settleAnswers();
    expect(answers).toEqual([
      { data: { device: 'phone' }, drawn: true },
      { data: { device: 'phone' }, drawn: true }
    ]);
    expect(answers).toHaveLength(shows.length);
  });

  it('answers a show of the tablet for the tablet', async () => {
    await renderOpen();
    send(false);
    flushSync();
    await settleAnswers();

    send({ device: 'tablet', visible: true });
    flushSync();
    await settleAnswers();
    expect(answers.slice(1)).toEqual([{ data: { device: 'tablet' }, drawn: true }]);
    expect(get(activeDevice)).toBe('tablet');
  });

  it('sends nothing when the frame throws while mounting', async () => {
    await renderOpen();
    send(false);
    flushSync();
    await settleAnswers();
    const asked = started.length;

    mount.fails = true;
    send(true);
    // In game this throw escapes in Svelte's own flush microtask; flushed here, it surfaces here.
    expect(() => flushSync()).toThrow('PhoneFrame failed to mount');
    await settleAnswers();
    expect(started, 'the shell asked').toHaveLength(asked + 1);
    expect(document.querySelector('[data-device-frame="phone"]')).toBeNull();
    expect(answers, 'no frame, no answer').toHaveLength(1);
  });
});
