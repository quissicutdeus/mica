// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The number printed on the Bank card: the same fixed pattern for everyone (MICA-433).
 *
 * It used to be sixteen digits hashed out of the player's citizenid — 32 bits of FNV-1a fed
 * to an LCG, so anyone holding a screenshot could brute-force it back to a candidate
 * citizenid, which on ESX is the player's Rockstar license. The card is decoration and there
 * is no card number anywhere else in the game, so nothing derived from any identifier is
 * shown at all.
 */
export const MASKED_CARD_NUMBER = '•••• •••• •••• ••••';
