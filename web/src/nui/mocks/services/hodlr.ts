// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mockHodlrBuyPrice,
  mockHodlrHolding,
  mockHodlrPrice,
  mockHodlrPriceHistory,
  mockHodlrSellPrice
} from '../data';
import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  // Hodlr — also routes through the generic service path, but custom actions rather
  // than the generic CRUD helper: portfolio/price are reads, buy/sell mutate state
  // that the generic four-verb shape (get/create/update/delete) cannot express.
  // `ready` is the market's own state rather than a loading flag: the server withholds the
  // quote until it has restored the price from storage after a restart (MICA-130). The
  // browser has no restart to survive, so the mock market is always open.
  // `buyPrice`/`sellPrice` (MICA-147/MICA-149) are the stand-in spread from
  // `data.ts` — `current` stays the mid/reference price the chart plots, unchanged.
  'hodlr:price': () => ({
    ready: true,
    current: mockHodlrPrice,
    buyPrice: mockHodlrBuyPrice,
    sellPrice: mockHodlrSellPrice,
    history: mockHodlrPriceHistory
  }),
  'hodlr:portfolio': () => ({
    ready: true,
    quantity: mockHodlrHolding.quantity,
    currentPrice: mockHodlrPrice,
    currentValue: mockHodlrHolding.quantity * mockHodlrPrice
  }),
  'hodlr:buy': ({ quantity }: { quantity: number }) => {
    mockHodlrHolding.quantity += quantity;
    return {
      ok: true,
      quantity: mockHodlrHolding.quantity,
      price: mockHodlrBuyPrice,
      cost: quantity * mockHodlrBuyPrice
    };
  },
  'hodlr:sell': ({ quantity }: { quantity: number }) => {
    if (mockHodlrHolding.quantity < quantity) {
      return { ok: false, reason: 'insufficient_holdings' };
    }
    mockHodlrHolding.quantity -= quantity;
    return {
      ok: true,
      quantity: mockHodlrHolding.quantity,
      price: mockHodlrSellPrice,
      proceeds: quantity * mockHodlrSellPrice
    };
  }
};
