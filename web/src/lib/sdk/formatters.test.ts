// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatDuration,
  formatTimestamp,
  formatTime,
  formatRelativeTime
} from './formatters';

describe('formatters utility module', () => {
  describe('formatCurrency', () => {
    it('formats numbers with 2 decimal places and comma separators', () => {
      expect(formatCurrency(1234567.89)).toBe('1,234,567.89');
      expect(formatCurrency(0)).toBe('0.00');
      expect(formatCurrency(50)).toBe('50.00');
    });
  });

  describe('formatTimestamp', () => {
    it('converts unix timestamp seconds to a formatted date string', () => {
      const timestamp = 1609459200; // 2021-01-01T00:00:00Z
      const formatted = formatTimestamp(timestamp);
      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    });
  });

  describe('formatTime', () => {
    it('returns empty string when input is undefined', () => {
      expect(formatTime()).toBe('');
    });

    it('formats valid date strings or Date objects', () => {
      const date = new Date('2026-07-24T14:30:00Z');
      const formatted = formatTime(date);
      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    });
  });

  describe('formatRelativeTime', () => {
    it('returns empty string for empty inputs', () => {
      expect(formatRelativeTime('')).toBe('');
    });

    it('returns "Just now" for current timestamp', () => {
      const now = new Date();
      expect(formatRelativeTime(now)).toBe('Just now');
    });

    it('returns minutes ago for dates within the hour', () => {
      const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinsAgo)).toBe('5m ago');
    });

    it('returns hours ago for dates within 24 hours', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
    });
  });
});

describe('formatDuration', () => {
  it('reads as a track length, not a timestamp', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(95)).toBe('1:35');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('grows an hours field only when there is one', () => {
    expect(formatDuration(3599)).toBe('59:59');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('refuses to render nonsense as a time', () => {
    // The value arrives from the embed (`reportPlayerProgress`), so it is checked here too.
    expect(formatDuration(-1)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});
