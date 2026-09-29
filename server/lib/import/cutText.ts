// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `text` cut to at most `max` UTF-16 units — the measure the contracts' bounds use, since they
 * check `.length` — without splitting a surrogate pair.
 *
 * `slice` alone can end between the two halves of an emoji, and the lone half left behind is
 * stored as U+FFFD, a replacement character the author never wrote. When the cut would land
 * there, it lands one unit earlier, so the result is never longer than `max`.
 */
export const cutText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  const last = text.charCodeAt(max - 1);
  const splitsAPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsAPair ? max - 1 : max);
};
