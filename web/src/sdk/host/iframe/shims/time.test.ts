import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { fakeTransport } from '../__fixtures__/fakeTransport';
import { setConstants } from '../constants';
import type { AddOnConstants, ToShell } from '../messages';
import { time, is24Hour, formattedTime } from './time';

const constantsWith = (is24: boolean): AddOnConstants => ({
  display: {},
  wallpaper: { presets: [], defaultWallpaper: null },
  systemHardware: { volumeStepChoices: [] },
  theme: { defaultTheme: null },
  clock: { is24Hour: is24 }
});

// MICA-16 step 4: this shim replaces `shell/state/time.ts` for the add-on build (see
// `vite.addon.config.ts`'s `resolveId` for `.../shell/state/time`) — it must not run its
// own wall clock, only subscribe to the `clock` facet the shell already ticks.

describe('shims/time', () => {
  /**
   * `is24Hour` is the one member here that is *not* a `remoteStore`, and the reason is
   * `formatTime`: it reads this synchronously while the frame paints, which a subscribe
   * reply cannot beat, and its callers do not declare the `clock` permission a subscribe
   * would need. So the value comes down in the hydrate constants instead.
   */
  it('reads is24Hour out of the hydrate constants, synchronously', () => {
    setConstants(constantsWith(true));
    expect(get(is24Hour)).toBe(true);

    setConstants(constantsWith(false));
    expect(get(is24Hour)).toBe(false);
  });

  it('does not subscribe to the clock facet for is24Hour', () => {
    setConstants(constantsWith(true));
    const f = fakeTransport();
    const off = is24Hour.subscribe(() => {});
    expect(
      f.sent.some((m) => m.kind === 'subscribe' && m.facet === 'clock' && m.member === 'is24Hour')
    ).toBe(false);
    off();
  });

  it('time and formattedTime subscribe to the same clock facet', () => {
    const f = fakeTransport();
    const offTime = time.subscribe(() => {});
    const offFormatted = formattedTime.subscribe(() => {});
    expect(
      f.sent.some((m) => m.kind === 'subscribe' && m.facet === 'clock' && m.member === 'time')
    ).toBe(true);
    expect(
      f.sent.some(
        (m) => m.kind === 'subscribe' && m.facet === 'clock' && m.member === 'formattedTime'
      )
    ).toBe(true);
    offTime();
    offFormatted();
  });

  it('pushes update the store instead of a setInterval reading the real clock', () => {
    const f = fakeTransport();
    const seen: { hours: number; minutes: number }[] = [];
    const off = time.subscribe((v) => seen.push(v));
    const sub = f.sent.find(
      (m) => m.kind === 'subscribe' && m.facet === 'clock' && m.member === 'time'
    ) as Extract<ToShell, { kind: 'subscribe' }>;
    f.pushes.get(sub.id)!({ hours: 9, minutes: 41 });
    expect(seen).toEqual([
      { hours: 0, minutes: 0 },
      { hours: 9, minutes: 41 }
    ]);
    off();
  });
});
