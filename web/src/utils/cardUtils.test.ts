import { describe, it, expect } from 'vitest';
import { hashStringToCardNumber } from './cardUtils';

describe('cardUtils', () => {
  it('returns default fallback card number for empty or falsy input', () => {
    expect(hashStringToCardNumber('')).toBe('4242 4242 4242 4242');
  });

  it('generates a deterministic 16-digit card number formatted in 4-digit groups starting with 4', () => {
    const card = hashStringToCardNumber('citizen123');
    expect(card).toMatch(/^4\d{3} \d{4} \d{4} \d{4}$/);
  });

  it('produces identical card numbers for identical inputs', () => {
    const card1 = hashStringToCardNumber('player_john_doe');
    const card2 = hashStringToCardNumber('player_john_doe');
    expect(card1).toBe(card2);
  });

  it('produces different card numbers for different inputs', () => {
    const card1 = hashStringToCardNumber('player_john');
    const card2 = hashStringToCardNumber('player_jane');
    expect(card1).not.toBe(card2);
  });
});
