// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import type { PrivacyExport } from '@mica/shared/types';
import {
  exportJson,
  holdsNothing,
  humanize,
  isRelayTimeout,
  listed,
  outcomeOf,
  rowsJson
} from './yourData';

const data: PrivacyExport = {
  generatedAt: '2026-09-28T00:00:00.000Z',
  limitChars: 1000,
  truncated: true,
  categories: [
    {
      category: 'notes',
      rows: [{ id: 1 }, { id: 2 }],
      truncated: false,
      withheld: []
    },
    {
      category: 'messages',
      rows: [{ id: 9 }],
      truncated: 'rows',
      withheld: ['ip']
    },
    {
      category: 'mail',
      rows: [],
      truncated: false,
      withheld: []
    }
  ]
};

describe('Your data logic', () => {
  it('lists a category with rows, and one the server cut even with no rows', () => {
    const cut: PrivacyExport = {
      ...data,
      categories: [
        ...data.categories,
        { category: 'media', rows: [], truncated: 'size', withheld: [] }
      ]
    };
    // `mail` is genuinely empty and whole, so it is left out; `media` is not held back
    // for being empty, because it is empty only in this view.
    expect(listed(cut).map((c) => c.category)).toEqual(['notes', 'messages', 'media']);
    expect(JSON.parse(exportJson(cut)).categories).toHaveLength(4);
  });

  it('only says nothing is held for a whole, empty export', () => {
    const empty: PrivacyExport = { ...data, truncated: false, categories: [] };
    expect(holdsNothing(empty)).toBe(true);
    // Cut at the top level: never proof of nothing, whatever the rows say.
    expect(holdsNothing({ ...empty, truncated: true })).toBe(false);
    // A cut category with no rows is a hole in the view, not an empty category.
    const hole: PrivacyExport = {
      ...empty,
      categories: [{ category: 'media', rows: [], truncated: 'size', withheld: [] }]
    };
    expect(holdsNothing(hole)).toBe(false);
    expect(holdsNothing(data)).toBe(false);
  });

  it('recognises the relay timeout by its message', () => {
    expect(isRelayTimeout(new Error('Request timed out'))).toBe(true);
    expect(isRelayTimeout(new Error('Wrong word'))).toBe(false);
    expect(isRelayTimeout('Request timed out')).toBe(false);
  });

  it('keeps truncation and withheld columns visible in the copied JSON', () => {
    const out = JSON.parse(exportJson(data));
    expect(out.truncated).toBe(true);
    expect(out.categories[1]).toMatchObject({ truncated: 'rows', withheld: ['ip'] });
  });

  it('pretty-prints one category', () => {
    expect(JSON.parse(rowsJson(data.categories[0]))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('humanizes a category key', () => {
    expect(humanize('messages_participants')).toBe('messages participants');
  });

  it('is partial when incomplete or when anything failed', () => {
    expect(outcomeOf({ complete: true, removed: 3, kept: 1, failed: [] })).toBe('done');
    expect(outcomeOf({ complete: false, removed: 3, kept: null, failed: ['mail'] })).toBe(
      'partial'
    );
    expect(outcomeOf({ complete: true, removed: 3, kept: 0, failed: ['mail'] })).toBe('partial');
  });
});
