// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The longest note body, in characters (MICA-431): `mica_notes.content` is a `text` holding the
 * body sealed to the phone, and 12,276 characters is the most whose sealed form fits. The
 * server derives the same number from the column (`maxPlaintextChars`), and
 * `server/__tests__/encryptedColumns.test.ts` holds the two together.
 *
 * Here, not in `shared/`: Notes is a Store add-on, and core may not name one
 * (`sdk/coreBoundary.test.ts`). The add-on owns its limit as it owns its contract
 * (`server/services/Notes.ts`).
 */
export const NOTE_CONTENT_MAX = 12276;

/** The longest note title, in characters: the column's declared bound. */
export const NOTE_TITLE_MAX = 255;
