// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The letters an avatar draws for a name or a handle, once (MICA-417).
 *
 * A leading `@` is dropped, so `@ada_l` and `Ada` agree. Two or more words give the first
 * letter of the first and of the last ("Ada King Lovelace" → "AL"); one word gives its first
 * letter ("ada" → "A"). Always uppercase. A letter is a code point, not a UTF-16 unit, so a
 * name that opens with an emoji draws the emoji rather than half of it.
 *
 * Nothing to draw — empty, whitespace, a bare `@` — gives `fallback`, `'?'` unless the caller
 * says otherwise. `Avatar` passes `''`, because no initials there means the silhouette.
 *
 * Before this, apps each wrote their own — `DmInbox` alone drew the first two characters of
 * a handle — so the same person could wear different letters in two apps.
 */
export function initialsOf(name: string | null | undefined, fallback = '?'): string {
  const words = (name ?? '').trim().replace(/^@/, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  const first = (word: string): string => [...word][0] ?? '';
  const letters =
    words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
  return letters.toUpperCase();
}
