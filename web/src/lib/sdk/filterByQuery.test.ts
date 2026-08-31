import { describe, it, expect } from 'vitest';
import { filterByQuery } from './filterByQuery';

type Row = { name: string; note?: string | null; phone: string };

const rows: Row[] = [
  { name: 'John Smith', note: 'owes me money', phone: '555-0100' },
  { name: 'Jane Doe', note: null, phone: '555-0199' },
  { name: 'Ursula', phone: '867-5309' }
];

const fields = (r: Row) => [r.name, r.note, r.phone];

describe('filterByQuery', () => {
  it('returns the list unchanged for an empty or whitespace-only query', () => {
    expect(filterByQuery(rows, '', fields)).toEqual(rows);
    expect(filterByQuery(rows, '   ', fields)).toEqual(rows);
  });

  it('matches any of the supplied fields, ignoring case', () => {
    expect(filterByQuery(rows, 'JOHN', fields).map((r) => r.name)).toEqual(['John Smith']);
    expect(filterByQuery(rows, 'owes', fields).map((r) => r.name)).toEqual(['John Smith']);
    expect(filterByQuery(rows, '5309', fields).map((r) => r.name)).toEqual(['Ursula']);
  });

  it('survives null and undefined fields', () => {
    // Ursula has no note at all and Jane's is null; neither may throw, and neither may
    // match a query the way an empty string would.
    expect(() => filterByQuery(rows, 'x', fields)).not.toThrow();
    expect(filterByQuery(rows, 'note', fields)).toEqual([]);
  });

  it('trims the query before matching every field, not just some of them', () => {
    // The divergence this replaces: Contacts trimmed the query for the phone number and
    // not for the name, so a trailing space silently changed which field could match.
    expect(filterByQuery(rows, ' 555-0100 ', fields).map((r) => r.name)).toEqual(['John Smith']);
    expect(filterByQuery(rows, ' john ', fields).map((r) => r.name)).toEqual(['John Smith']);
  });

  it('lets a caller search a value it composes', () => {
    // "john sm" spans first and last name, so no per-key match would find it.
    const composed = filterByQuery(rows, 'john sm', (r) => [r.name]);
    expect(composed.map((r) => r.name)).toEqual(['John Smith']);
  });

  it('returns every match rather than the first', () => {
    expect(filterByQuery(rows, '555', fields)).toHaveLength(2);
  });
});
