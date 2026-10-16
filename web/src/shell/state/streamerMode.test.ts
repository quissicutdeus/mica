// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against — in-process, because a
 * unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { useStorage } from '@mica/sdk';
import {
  revealGeneration,
  sanitizeStreamerMode,
  setStreamerMode,
  streamerMode
} from './streamerMode';
import { currentApp } from './navigation';
import { openDevice } from './phoneOpen';

/**
 * MICA-249. What is worth pinning is the resolution rule and the re-blur trigger: a
 * stored value only ever reads as on when it is literally `true`, and the generation
 * moves on exactly the events after which a revealed picture should hide again. Whether
 * anything is actually blurred is `MediaThumb.test.ts`'s question.
 */
describe('streamer mode', () => {
  beforeEach(() => {
    setStreamerMode(false);
    currentApp.set({ id: 'home', props: {} });
    openDevice.set(null);
  });

  it('is off unless the stored value is literally true', () => {
    expect(sanitizeStreamerMode(true)).toBe(true);
    expect(sanitizeStreamerMode('true')).toBe(false);
    expect(sanitizeStreamerMode(1)).toBe(false);
    expect(sanitizeStreamerMode(undefined)).toBe(false);
  });

  it('persists under settings so it follows the character', () => {
    setStreamerMode(true);
    expect(get(streamerMode)).toBe(true);
    expect(useStorage('settings').getItem<boolean>('streamerMode', false)).toBe(true);
    setStreamerMode(false);
    expect(useStorage('settings').getItem<boolean>('streamerMode', false)).toBe(false);
  });

  it('bumps the generation when the flag flips, the foreground app changes, or the device closes', () => {
    const seen: number[] = [];
    const stop = revealGeneration.subscribe((g) => seen.push(g));
    // The initial value, whatever an earlier subscription left it at — the value means nothing.
    expect(seen).toHaveLength(1);

    setStreamerMode(true);
    expect(seen.length).toBe(2);

    currentApp.set({ id: 'media', props: {} });
    expect(seen.length).toBe(3);

    openDevice.set('phone');
    openDevice.set(null);
    expect(seen.length).toBe(5);

    // Strictly increasing: a subscriber reacts to change, never to a value.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    stop();
  });

  /**
   * The store stops when its last subscriber leaves — every thumb unmounts when the phone
   * closes — and keeps its last value. A counter that restarted with it would set that same
   * value on the next bump, which a store does not report as a change, so a picture revealed
   * after the phone reopened stayed revealed when the foreground app changed.
   */
  it('still bumps after every subscriber has left and a new one arrives', () => {
    const first: number[] = [];
    const stopFirst = revealGeneration.subscribe((g) => first.push(g));
    currentApp.set({ id: 'media', props: {} });
    stopFirst();
    const left = first[first.length - 1];

    const second: number[] = [];
    const stopSecond = revealGeneration.subscribe((g) => second.push(g));
    expect(second).toEqual([left]);
    currentApp.set({ id: 'messages', props: {} });
    expect(second, 'a bump after resubscribing must reach the subscriber').toHaveLength(2);
    expect(second[1]).not.toBe(left);
    stopSecond();
  });
});
