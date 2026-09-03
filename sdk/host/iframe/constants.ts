// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AddOnConstants } from './messages';

// MICA-16 step 4: the numeric/shape constants the shell hands over at hydrate — defaults
// and bounds that are not worth a round trip (and, unlike storage, never change mid-session).

let current: AddOnConstants | undefined;

export function setConstants(c: AddOnConstants): void {
  current = c;
}

export function constants(): AddOnConstants {
  if (!current) throw new Error('[gOS] add-on constants used before bootAddOn() ran.');
  return current;
}
