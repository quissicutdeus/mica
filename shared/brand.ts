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
 * name, not prose, and a catalog entry per language would be the same few characters
 * copied into every one of them, free to drift. Prose *about* the OS still goes through
 * `$t` and takes this as a parameter, which is what `shell.previewNav` does.
 */
export const OS_NAME = 'micaOS';

/**
 * The nine choirs, in the traditional order, highest first (MICA-273).
 *
 * An operating system puts its personality in its release names rather than its product
 * name -- Android had desserts, Ubuntu has animals, macOS has places -- and this is that
 * slot. The sequence is already ranked, so the next release picks itself and nobody has
 * to hold an opinion about it.
 *
 * It is the world the `quissicutdeus` handle comes from -- "Quis sicut Deus", the cry of
 * Michael, who is an archangel and so belongs to the eighth of these -- without putting
 * anybody's first name on the product.
 */
export const OS_CODENAMES = [
  'Seraphim',
  'Cherubim',
  'Thrones',
  'Dominions',
  'Virtues',
  'Powers',
  'Principalities',
  'Archangels',
  'Angels'
] as const;

/** The choir this major version ships under. Advance it with the major, not the patch. */
export const OS_CODENAME: (typeof OS_CODENAMES)[number] = 'Seraphim';
