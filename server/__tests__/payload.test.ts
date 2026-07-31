import { describe, it, expect } from 'vitest';
import { conversationIdFrom, requirePositiveInt } from '../lib/payload';

describe('requirePositiveInt', () => {
  it.each([
    ['a plain number', 7, 7],
    ['a numeric string', '7', 7]
  ])('accepts %s', (_label, input, expected) => {
    expect(requirePositiveInt(input, 'id')).toBe(expected);
  });

  it.each([
    ['zero', 0],
    ['a negative', -3],
    ['a fraction', 1.5],
    ['a non-numeric string', 'abc'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['an object', { id: 1 }],
    ['an array', [1]],
    ['NaN', NaN],
    ['Infinity', Infinity]
  ])('rejects %s', (_label, input) => {
    expect(() => requirePositiveInt(input, 'conversation_id')).toThrow(
      /A valid conversation_id is required/
    );
  });
});

describe('conversationIdFrom', () => {
  it('reads conversation_id, the shape most of the UI sends', () => {
    expect(conversationIdFrom({ conversation_id: 4 })).toBe(4);
  });

  it('falls back to id, the shape the generic CRUD path sends', () => {
    expect(conversationIdFrom({ id: 5 })).toBe(5);
  });

  it('prefers conversation_id when a payload carries both', () => {
    expect(conversationIdFrom({ conversation_id: 4, id: 99 })).toBe(4);
  });

  it('accepts a bare id', () => {
    expect(conversationIdFrom(6)).toBe(6);
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a payload whose id is a string', { conversation_id: 'abc' }]
  ])('rejects %s', (_label, input) => {
    expect(() => conversationIdFrom(input)).toThrow(/A valid conversation_id is required/);
  });
});
