import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { signalLevel, clampedSignalLevel, setSignal } from './signal';

describe('Signal Store', () => {
  beforeEach(() => {
    setSignal(4);
  });

  it('defaults to 4 signal bars', () => {
    expect(get(signalLevel)).toBe(4);
    expect(get(clampedSignalLevel)).toBe(4);
  });

  it('updates signal level within valid range (0-4)', () => {
    setSignal(2);
    expect(get(signalLevel)).toBe(2);
    expect(get(clampedSignalLevel)).toBe(2);
  });

  it('clamps signal level when values out of bounds are passed', () => {
    setSignal(10);
    expect(get(clampedSignalLevel)).toBe(4);

    setSignal(-5);
    expect(get(clampedSignalLevel)).toBe(0);
  });
});
