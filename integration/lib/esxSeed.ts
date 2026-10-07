// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one character the box's wrapper puts into es_extended's `users` table before the esx run's
 * FXServer starts (MICA-304), so a scenario has an offline ESX character to look up without a
 * player ever connecting. The wrapper writes these same values as SQL, and
 * `server/__tests__/smokeWrapper.test.ts` holds the two to each other: change one and that test
 * fails until the other follows.
 *
 * `phone` is in `users.phone_number` only, the column ESX Legacy's own `legacy.sql` ships and
 * the second of the three spellings micaOS's offline lookup probes for. micaOS has issued this
 * character no number of its own, so a lookup by it can only have come from reading ESX's row.
 * On ESX the identifier *is* the citizenid.
 */
export const ESX_SEED = {
  identifier: 'license:itxesx01',
  firstname: 'Ada',
  lastname: 'Quill',
  phone: '5550100456'
} as const;
