// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_ROWS, firstPageAnchor, firstPageStart } from './firstPage';

/** Rows with ids `from`, `from + 1`, … — the shape `usePagedList` hands the app. */
const rows = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => ({ id: from + i }));

describe('firstPageStart (MICA-448)', () => {
  it('opens on the newest rows, not the whole page', () => {
    expect(firstPageStart(rows(50), null)).toBe(50 - FIRST_PAGE_ROWS);
  });

  it('shows everything when the thread is shorter than the first page', () => {
    expect(firstPageStart(rows(4), null)).toBe(0);
    expect(firstPageStart([], null)).toBe(0);
  });

  it('holds the first row by id, so a new message appends rather than pushing one out', () => {
    const before = rows(50);
    const anchor = before[firstPageStart(before, null)].id;
    const after = [...before, { id: 999 }];
    expect(after[firstPageStart(after, anchor)].id).toBe(anchor);
  });

  it('falls back to the newest rows when the anchored message is gone', () => {
    expect(firstPageStart(rows(50), 12345)).toBe(50 - FIRST_PAGE_ROWS);
  });
});

describe('firstPageAnchor (MICA-448)', () => {
  it('anchors on the newest page when nothing is unread', () => {
    const r = rows(50, 101);
    expect(firstPageAnchor(r, 0, -1)).toBe(r[50 - FIRST_PAGE_ROWS].id);
  });

  it('grows to take in an unread divider older than the first page, one message above it', () => {
    // 25 unread of 50: the divider sits at index 25, beyond the newest fifteen.
    const r = rows(50, 101);
    expect(firstPageAnchor(r, 0, 25)).toBe(r[24].id);
  });

  it('reads the divider against the whole thread, not the window', () => {
    // The window starts 150 rows into a 200-row thread, as after paging.
    const r = rows(50, 151);
    expect(firstPageAnchor(r, 150, 170)).toBe(r[19].id);
  });

  it('stays on the newest page when the unread run fits inside it', () => {
    const r = rows(50, 101);
    expect(firstPageAnchor(r, 0, 48)).toBe(r[50 - FIRST_PAGE_ROWS].id);
  });

  it('leaves a divider outside the window to the fallback', () => {
    const r = rows(50, 151);
    expect(firstPageAnchor(r, 150, 20)).toBe(r[50 - FIRST_PAGE_ROWS].id);
  });

  it('has no anchor for an empty thread', () => {
    expect(firstPageAnchor([], 0, -1)).toBeNull();
  });
});
