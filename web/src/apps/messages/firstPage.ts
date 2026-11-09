// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The first page a thread opens on, smaller than the page it pages by (MICA-448).
 *
 * Opening a thread renders it in one task: every bubble is built, styled and laid out
 * before the first frame can show the bottom. At fifty rows that task ran well past what a
 * frame can hold, and most of the rows were above the fold where nobody had scrolled yet.
 * So the open shows the newest {@link FIRST_PAGE_ROWS}, and the first "Load older" or the
 * first scroll to the top reveals the rest of the page. From there `usePagedList` pages
 * exactly as it did, fifty at a time.
 *
 * The first page is held by the id of its first row, not by a count. A count from the end
 * would drop the top row every time a message arrived, so a reader who had scrolled up a
 * little would watch the thread shift under them. An id keeps the first row where it is,
 * and new messages append below.
 */
export const FIRST_PAGE_ROWS = 15;

/**
 * Where the open's first page starts in `rows`, the window `usePagedList` hands over.
 *
 * Without an anchor yet (the thread is still loading, or it was cached and drawn before the
 * load answered), it is the newest {@link FIRST_PAGE_ROWS}. An anchor that has gone, because
 * that message was unsent, falls back the same way rather than showing the whole page.
 */
export function firstPageStart(
  rows: readonly { id: number }[],
  anchorId: number | null,
  size: number = FIRST_PAGE_ROWS
): number {
  if (anchorId !== null) {
    const at = rows.findIndex((row) => row.id === anchorId);
    if (at >= 0) return at;
  }
  return Math.max(0, rows.length - size);
}

/**
 * The id the first page should start at once the thread has loaded.
 *
 * `dividerIndex` is the unread divider's index in the whole thread and `offset` is where
 * `rows` starts in it, the same pair `MessageThread` compares. When the unread run is longer
 * than the first page, the page grows to take the divider in, with one message above it so
 * the reader sees where the unread ones begin. A divider outside `rows` altogether is left to
 * the app's fallback, as it was before the first page existed.
 */
export function firstPageAnchor(
  rows: readonly { id: number }[],
  offset: number,
  dividerIndex: number,
  size: number = FIRST_PAGE_ROWS
): number | null {
  if (rows.length === 0) return null;
  let start = Math.max(0, rows.length - size);
  const divider = dividerIndex - offset;
  if (dividerIndex >= 0 && divider >= 0 && divider < rows.length) {
    start = Math.min(start, Math.max(0, divider - 1));
  }
  return rows[start].id;
}
