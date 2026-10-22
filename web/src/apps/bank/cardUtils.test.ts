// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import { formatCurrency } from '@mica/sdk';
import { MASKED_CARD_NUMBER } from './cardUtils';
import CreditCard from './components/CreditCard.svelte';

describe('the Bank card number', () => {
  it('carries no digit at all, so there is nothing to reverse (MICA-433)', () => {
    expect(MASKED_CARD_NUMBER).not.toMatch(/\d/);
    // Still reads as a card: four groups of four.
    expect(MASKED_CARD_NUMBER).toMatch(/^(\S{4} ){3}\S{4}$/);
  });

  it('is what the card renders, and the card is handed no identifier to derive one from', () => {
    const { container } = render(CreditCard, { props: { balance: 1234 } });
    expect(container.textContent).toContain(MASKED_CARD_NUMBER);
    // The balance is the only number on the card.
    const rest = (container.textContent ?? '').replace(formatCurrency(1234), '');
    expect(rest).not.toMatch(/\d/);
  });
});
