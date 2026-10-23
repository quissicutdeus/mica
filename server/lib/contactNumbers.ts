// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What counts as the same number on one phone's contacts (MICA-432): the comparison
 * `phone_key`'s collation made before the number was sealed — case-blind, trailing spaces
 * ignored. `555-0100` and `5550100` are still two numbers, as the player typed them.
 *
 * Its own module so the importer can compare as Contacts does without loading the service,
 * which reaches `Devices` and every resolver it installs.
 */
export const contactNumberKey = (phone: string): string => phone.toLowerCase().trimEnd();
