import { describe, it, expect } from 'vitest';
import { conversationIdFrom, pageBounds, requirePositiveInt } from '../lib/payload';

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

/**
 * The page a custom action was asked for.
 *
 * `ServiceEndpoint` clamps the generic `get`; a custom action pages itself and has to clamp its
 * own, which is why this is shared rather than written out per service — Blabber's `profile` and
 * `following` and the accounts service's two follower lists are all the same four lines.
 */
describe('pageBounds', () => {
  const paging = { pageSize: 30, maxPageSize: 60 };

  it('falls back to the declared page size when no limit is asked for', () => {
    expect(pageBounds({}, paging)).toEqual({ limit: 30, cursor: null });
  });

  it('honours a limit inside the declared ceiling', () => {
    expect(pageBounds({ limit: 5 }, paging).limit).toBe(5);
  });

  it('clamps an over-large limit rather than refusing it', () => {
    // The request is legitimate; only the number is not (§10).
    expect(pageBounds({ limit: 5000 }, paging).limit).toBe(60);
  });

  it.each([
    ['a fraction', 1.5],
    ['zero', 0],
    ['a negative', -10],
    ['a string', '20'],
    ['a non-scalar', [20]]
  ])('ignores %s and uses the declared page size', (_label, limit) => {
    expect(pageBounds({ limit }, paging).limit).toBe(30);
  });

  it('reads the numbers from the declaration it was handed, not from constants', () => {
    // What stops a change to a `paging` declaration from silently missing that service's custom
    // actions — which is exactly what two retyped numbers in Blabber.ts would have done.
    expect(pageBounds({}, { pageSize: 10, maxPageSize: 20 })).toEqual({ limit: 10, cursor: null });
    expect(pageBounds({ limit: 999 }, { pageSize: 10, maxPageSize: 20 }).limit).toBe(20);
  });

  it('treats an absent or null cursor as the first page', () => {
    expect(pageBounds({}, paging).cursor).toBeNull();
    expect(pageBounds({ cursor: null }, paging).cursor).toBeNull();
  });

  it('accepts a bare row id as the cursor', () => {
    expect(pageBounds({ cursor: 42 }, paging).cursor).toBe(42);
  });

  it.each([
    ['a column name', 'created_at'],
    ['an injection attempt', '1; DROP TABLE'],
    ['a fraction', 4.5],
    ['zero', 0]
  ])('rejects %s as a cursor', (_label, cursor) => {
    // A cursor names a position in a result set the caller may already read, so it needs no
    // signing — but it must never be able to name a column.
    expect(() => pageBounds({ cursor }, paging)).toThrow(/A valid cursor is required/);
  });

  it('reads nothing out of a payload that is not an object', () => {
    expect(pageBounds(undefined, paging)).toEqual({ limit: 30, cursor: null });
    expect(pageBounds('nonsense', paging)).toEqual({ limit: 30, cursor: null });
  });
});
