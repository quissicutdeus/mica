// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { t, useService } from '@gphone/sdk';
import type { PricePoint } from '@gphone/shared/types';

/**
 * Hodlr's own data layer, inside the app — see `apps/notes/store.ts` for why: an
 * add-on cannot add a hook to the SDK or a store to core's `services/` directory.
 *
 * `useService('hodlr')` routes through the one generic NUI callback, so
 * `shared/routes.ts` needs no row and core never learns this app exists.
 */
const service = () => useService('hodlr');

/**
 * `ready` is the market's own state, not this store's loading flag.
 *
 * The server withholds the quote until it has checked the price against storage after a
 * restart (MICA-130) — during that window `current` is 0 rather than the opening constant,
 * because a confident wrong number is worse than none. `history` still arrives: it comes
 * from storage rather than from the unrestored price, so the chart is correct throughout.
 *
 * It is also `false` on the `fetchNui` default below, which is the right reading — a request
 * that never answered has not established a price either.
 */
export interface PriceInfo {
  ready: boolean;
  /** The mid/reference price — what `history` charts, and a spread's own center. */
  current: number;
  /**
   * What buying costs per unit right now, and what selling nets (MICA-147/MICA-149).
   *
   * Optional, and deliberately falls back to `current` via `buyPriceOf`/`sellPriceOf`
   * below rather than requiring the field: the spread itself is server business logic
   * (`server/services/Hodlr.ts`, not built by this ticket's web half), so a reply that
   * predates it — or a test fixture that never mentions it — still quotes one honest
   * number instead of `undefined`.
   */
  buyPrice?: number;
  sellPrice?: number;
  history: PricePoint[];
}

/** What a buy actually costs per unit — the spread's upper quote, or `current` without one. */
export const buyPriceOf = (info: PriceInfo): number => info.buyPrice ?? info.current;

/** What a sell actually nets per unit — the spread's lower quote, or `current` without one. */
export const sellPriceOf = (info: PriceInfo): number => info.sellPrice ?? info.current;

export interface Portfolio {
  ready: boolean;
  quantity: number;
  currentPrice: number;
  currentValue: number;
}

export type TradeOutcome =
  | { ok: true; quantity: number; price: number; cost?: number; proceeds?: number }
  | { ok: false; reason: string };

/**
 * A refusal from the server, in words a player can act on.
 *
 * `buy`/`sell` answer with a machine slug rather than a sentence, and Trade used to render
 * that slug straight into the screen — so a rejected sell read `insufficient_holdings`
 * (MICA-99). The server is the thing that refuses (a modified client can emit
 * `gphone:server:hodlr:sell` with any quantity, AGENTS.md §2.9), so the slug always has to
 * be translatable here rather than only being avoided by the button guard.
 *
 * An unrecognised slug falls through to a generic line instead of being shown raw: a new
 * server-side reason should read as a failure, not as debug output.
 */
export const tradeFailureMessage = (reason: string, holding: number): string => {
  // Not a component, so the translator is read out of its store rather than with `$t`.
  const translate = get(t);
  switch (reason) {
    case 'insufficient_holdings':
      return translate('hodlr.failInsufficientHoldings', { holding });
    case 'insufficient_funds':
      return translate('hodlr.failInsufficientFunds');
    case 'exceeds_limit':
      return translate('hodlr.failExceedsLimit');
    case 'market_unavailable':
      return translate('hodlr.failMarketUnavailable');
    case 'debit_failed':
    case 'credit_failed':
      return translate('hodlr.failBankRefused');
    case 'request_failed':
      return translate('hodlr.failNoAnswer');
    default:
      return translate('hodlr.failGeneric');
  }
};

const emptyPrice: PriceInfo = { ready: false, current: 0, history: [] };
const emptyPortfolio: Portfolio = { ready: false, quantity: 0, currentPrice: 0, currentValue: 0 };

export const priceStore = writable<PriceInfo>({ ...emptyPrice });
export const portfolioStore = writable<Portfolio>({ ...emptyPortfolio });

export const loadPrice = async (): Promise<void> => {
  const info = await service().call<PriceInfo>('price', {}, emptyPrice);
  priceStore.set(info);
};

export const loadPortfolio = async (): Promise<void> => {
  const portfolio = await service().call<Portfolio>('portfolio', {}, emptyPortfolio);
  portfolioStore.set(portfolio);
};

const applyTrade = (outcome: TradeOutcome): void => {
  if (!outcome.ok) return;
  portfolioStore.update((p) => ({
    ...p,
    quantity: outcome.quantity,
    currentValue: outcome.quantity * outcome.price
  }));
};

export const buy = async (quantity: number): Promise<TradeOutcome> => {
  const outcome = await service().call<TradeOutcome>(
    'buy',
    { quantity },
    { ok: false, reason: 'request_failed' }
  );
  applyTrade(outcome);
  return outcome;
};

export const sell = async (quantity: number): Promise<TradeOutcome> => {
  const outcome = await service().call<TradeOutcome>(
    'sell',
    { quantity },
    { ok: false, reason: 'request_failed' }
  );
  applyTrade(outcome);
  return outcome;
};

export function useHodlr() {
  return { priceStore, portfolioStore, loadPrice, loadPortfolio, buy, sell, tradeFailureMessage };
}
