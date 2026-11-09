// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';

import { SDK_CONTRACT_VERSION } from './version';

/**
 * The contract version moves only on the owner's explicit word (MICA-459).
 *
 * The owner rule of 2026-11-09 was text in `lead-protocol` and the `sdk` agent's stop list,
 * and text is what a lane or a hurried edit gets past. The two gates that already read the
 * pin do not hold it either: `publicSurface.test.ts` fails on a bump until the baselines are
 * re-frozen, which is an instruction to finish the bump, and `sdkChangelog.test.ts` asks only
 * for a CHANGELOG entry, which is all a lane would need to write. This file is the one that
 * says no.
 *
 * `sdk/version.ts` still decides what counts as a break; this does not. It only refuses to let
 * the number move without the owner moving it here too, so the decision is a line in review.
 *
 * **Read by import, not as source text.** It matches how both sibling gates read the pin, and
 * it checks the value the shell's `assertContractSupported` and every add-on actually compare
 * against: a text read checks how one line is spelled and passes a value that is computed or
 * re-exported from elsewhere. The usual objection to an import, a mock, would have to be a
 * `vi.mock('./version')` in this same file, where review sees it.
 *
 * **The expected value is a literal, and stays one.** Not a snapshot, which `vitest -u`
 * rewrites silently, and not a constant shared with `BASELINE_VERSION` or anything else that
 * moves with the pin; either would let the gate agree with whatever the pin says.
 */
describe('SDK_CONTRACT_VERSION', () => {
  it('moves only on the owner’s explicit go-ahead', () => {
    expect(
      SDK_CONTRACT_VERSION,
      `SDK_CONTRACT_VERSION is '${SDK_CONTRACT_VERSION}', not '1'. ` +
        'The SDK contract version moves only on the owner’s explicit go-ahead ' +
        '(owner rule, 2026-11-09), even where the rule in sdk/version.ts says a break needs ' +
        'it. If a change seems to call for moving it, restore sdk/version.ts and return it to ' +
        'the lead as a finding; do not edit this test to match. The owner’s own change is a ' +
        'one-line edit to the expected value in sdk/version.test.ts, in the same commit.'
    ).toBe('1');
  });
});
