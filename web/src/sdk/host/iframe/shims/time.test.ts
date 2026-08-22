import { describe, it, expect } from 'vitest';
import { fakeTransport } from '../__fixtures__/fakeTransport';
import type { ToShell } from '../messages';
import { time, is24Hour, formattedTime } from './time';

// MICA-16 step 4: this shim replaces `shell/state/time.ts` for the add-on build (see
// `vite.addon.config.ts`'s `resolveId` for `.../shell/state/time`) — it must not run its
// own wall clock, only subscribe to the `clock` facet the shell already ticks.

describe('shims/time', () => {
  it('subscribing to is24Hour sends a clock subscribe, not a local timer', () => {
    const f = fakeTransport();
    const off = is24Hour.subscribe(() => {});
    const sub = f.sent.find(
      (m) => m.kind === 'subscribe' && m.facet === 'clock' && m.member === 'is24Hour'
    ) as Extract<ToShell, { kind: 'subscribe' }>;
    expect(sub).toBeDefined();
    expect(sub.factoryArgs).toEqual([]);
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
    const seen: boolean[] = [];
    const off = is24Hour.subscribe((v) => seen.push(v));
    const sub = f.sent.find(
      (m) => m.kind === 'subscribe' && m.facet === 'clock' && m.member === 'is24Hour'
    ) as Extract<ToShell, { kind: 'subscribe' }>;
    f.pushes.get(sub.id)!(true);
    expect(seen).toEqual([false, true]);
    off();
  });
});
