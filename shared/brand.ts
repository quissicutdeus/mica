// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the software calls itself, as distinct from what the hardware is called.
 *
 * The device names live on the device table (`DeviceDescriptor.brand` in `devices.ts`):
 * a gPhone and a gTablet are two devices. This is the one name above them both -- the
 * operating system they each run -- and it is what belongs anywhere the subject is the
 * software rather than the thing in the player's hand.
 *
 * A constant rather than a locale key, for the reason `brand` is one: it is a product
 * name, not prose, and a catalog entry per language would be the same six characters
 * copied into every one of them, free to drift. Prose *about* the OS still goes through
 * `$t` and takes this as a parameter, which is what `shell.previewNav` does.
 *
 * `web/src/apps/settings` still says `gPhone` in roughly twenty-five strings that mean
 * the software rather than the phone; MICA-267 is the pass that brings them here.
 */
export const OS_NAME = 'gOS';
