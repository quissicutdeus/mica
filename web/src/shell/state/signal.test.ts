import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  signalLevel,
  clampedSignalLevel,
  setSignal,
  cellServiceEnabled,
  setCellServiceEnabled,
  toggleCellService
} from './signal';

describe('Signal Store', () => {
  beforeEach(() => {
    setSignal(4);
    setCellServiceEnabled(true);
  });

  it('defaults to 4 signal bars and cell service enabled', () => {
    expect(get(signalLevel)).toBe(4);
    expect(get(clampedSignalLevel)).toBe(4);
    expect(get(cellServiceEnabled)).toBe(true);
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

  it('forces clamped signal level to 0 bars when cell service is disabled', () => {
    setSignal(4);
    setCellServiceEnabled(false);

    expect(get(cellServiceEnabled)).toBe(false);
    expect(get(clampedSignalLevel)).toBe(0);

    toggleCellService();
    expect(get(cellServiceEnabled)).toBe(true);
    expect(get(clampedSignalLevel)).toBe(4);
  });
});
