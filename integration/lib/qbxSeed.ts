// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one character the box's wrapper puts into qbx_core's `players` table before the qbx run's
 * FXServer starts (MICA-304), so a scenario has an offline qbx character to look up without a
 * player ever connecting. The wrapper writes these same values as SQL, and
 * `server/__tests__/smokeWrapper.test.ts` holds the two to each other: change one and that test
 * fails until the other follows.
 *
 * `phone` is in `charinfo` only. micaOS has issued this character no number of its own, so a
 * lookup that answers with it can only have come from reading qbx's own row, which is the
 * fallback `qbFindOfflineByPhone` exists for.
 */
export const QBX_SEED = {
  citizenid: 'ITXQBX01',
  firstname: 'Ada',
  lastname: 'Quill',
  phone: '5550100123'
} as const;
