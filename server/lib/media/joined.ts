// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A photo joined into another app's read — a Blab's, a post's, a listing's, a text's, a dating
 * profile's — as the row `openRow` opens (MICA-431).
 *
 * The photo's sealed columns are bound to the phone it is on, not to anything the joining read
 * is about, so the join selects that photo's own `citizenid` and `device_id` under these two
 * aliases. They are put back under their column names here and nowhere else, so the opened row
 * is the only thing that carries them, and the caller builds its wire shape from that row's
 * three opened values: neither the uploader's citizenid nor their phone reaches a reply.
 *
 * Text, whichever form the driver handed a `mediumtext` in: a Buffer would cross NUI as
 * `{type:'Buffer'}` and render as nothing, and it would never open.
 */
export interface JoinedMediaRow {
  media_id: unknown;
  media_citizenid?: unknown;
  media_device_id?: unknown;
  data?: unknown;
  thumbnail?: unknown;
  alt_text?: unknown;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export const joinedMedia = (
  row: JoinedMediaRow
): {
  id: unknown;
  citizenid: string | null;
  device_id: string | null;
  data: string | null;
  thumbnail: string | null;
  alt_text: string | null;
} => ({
  id: row.media_id,
  citizenid: text(row.media_citizenid),
  device_id: text(row.media_device_id),
  data: text(row.data),
  thumbnail: text(row.thumbnail),
  alt_text: text(row.alt_text)
});
