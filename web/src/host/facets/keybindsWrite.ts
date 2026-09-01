// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { resetBindings, setBinding } from '../../shell/state/keybinds';

/**
 * Implementation of the `useKeybindsWrite` facet — see the `useKeybindsWrite` hook doc for
 * the usage contract. Split out of `keybinds` (MICA-127): claiming an action for your
 * own app and rebinding — or wiping — every key on the phone are not the same ask.
 */
export function keybindsWrite() {
  return {
    setBinding,
    resetBindings
  };
}

registerFacet('keybindsWrite', keybindsWrite);
