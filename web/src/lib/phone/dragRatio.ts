// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How many CSS pixels of content one pixel of cursor travel is worth — the shell's name for
 * it, kept so `pointerDrag.ts` and `dragScroll.ts` read as before.
 *
 * The implementation is the SDK's since MICA-294, published as `measureDragRatio` so an app
 * can make the same correction (Places pans its map with it). One measurement, not two
 * copies that could come to disagree; the reasoning lives beside it in `@mica/sdk`.
 */
export { measureDragRatio } from '@mica/sdk';
