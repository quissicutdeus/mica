import { describe, it, expect } from 'vitest';
import { formatCurrency, formatTimestamp, formatTime, formatRelativeTime } from './formatters';

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
