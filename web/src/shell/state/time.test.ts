import { describe, it, expect } from 'vitest';
import { time, is24Hour, formattedTime } from './time';
import { get } from 'svelte/store';

describe('time store', () => {
  it('formats time in 12-hour format by default', () => {
    time.set({ hours: 14, minutes: 30 });
    is24Hour.set(false);

    expect(get(formattedTime)).toBe('2:30 PM');
  });

  it('formats time in 24-hour format when enabled', () => {
    time.set({ hours: 14, minutes: 30 });
    is24Hour.set(true);

    expect(get(formattedTime)).toBe('14:30');
  });

  it('handles midnight formatting in 12-hour format', () => {
    time.set({ hours: 0, minutes: 5 });
    is24Hour.set(false);

    expect(get(formattedTime)).toBe('12:05 AM');
  });
});
