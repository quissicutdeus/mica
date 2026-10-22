// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `AccountMenu` draws (MICA-410). Declared in a `.ts` sibling rather than the component
 * for the reason `recentlyDeleted.ts` gives: a type declared in a `.svelte` script is invisible
 * to plain `tsc`, and these names are on the public barrel.
 */

/**
 * One identity the player can switch to. Structural, so a `shared/types` `Account` passes as
 * it is and an add-on with its own row shape needs only these four fields.
 */
export interface AccountMenuAccount {
  id: string | number;
  /** Without the `@`; the menu draws it. */
  handle: string;
  display_name?: string | null;
  avatar?: string | null;
}

/** One row below the accounts: a button, and nothing else. */
export interface AccountMenuAction {
  label: string;
  onselect: () => void;
  /** `'danger'` draws the label in the error role — block, report, unmatch for good. */
  tone?: 'default' | 'danger';
  /** A `data-testid` for the button, for a spec that drove the app's own copy. */
  testid?: string;
}
