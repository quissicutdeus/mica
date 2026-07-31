import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchNui } from './fetchNui';

describe('fetchNui utility module', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaultValue in browser environment when mock data is absent', async () => {
    const result = await fetchNui(
      'nonExistentEvent',
      { test: true },
      { defaultValue: { success: true } }
    );
    expect(result).toEqual({ success: true });
  });

  it('handles custom fallback when default value is an empty array', async () => {
    const result = await fetchNui('getContacts', {}, { defaultValue: [] });
    expect(Array.isArray(result)).toBe(true);
  });
});
