// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: a test file is its own entry point, so it says which side it stands in for:
 * in-process, standing in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Transaction } from '@mica/sdk';

import TransactionItem from './TransactionItem.svelte';

const transaction = (direction: 'in' | 'out'): Transaction => ({
  id: 'tx-1',
  title: 'Paycheck',
  amount: 250,
  direction,
  time: 1_760_000_000
});

/**
 * MICA-411: money in was `text-green-400`, a palette literal, beside `text-error`, a role.
 * The literal does not follow the scheme, so axe measured it at 1.49:1 on the light surface
 * (`a11y.spec.ts`'s `bank` entry). Both directions take a role token now; the colour check
 * itself is that spec's, since jsdom computes no contrast.
 */
describe('TransactionItem', () => {
  it('draws money in with a themed role, not a palette literal', () => {
    render(TransactionItem, { props: { transaction: transaction('in') } });
    const amount = screen.getByText(/^\+\$/);
    expect(amount.className).not.toMatch(/\btext-green-\d+/);
    expect(amount.classList.contains('text-on-surface')).toBe(true);
  });

  it('keeps money out on the error role', () => {
    render(TransactionItem, { props: { transaction: transaction('out') } });
    expect(screen.getByText(/^-\$/).classList.contains('text-error')).toBe(true);
  });
});
