import { writable } from 'svelte/store';
import { useService } from '@gphone/sdk';
import type { PricePoint } from '@shared/types';

/**
 * Hodlr's own data layer, inside the app — see `apps/notes/store.ts` for why: an
 * add-on cannot add a hook to the SDK or a store to core's `services/` directory.
 *
 * `useService('hodlr')` routes through the one generic NUI callback, so
 * `shared/routes.ts` needs no row and core never learns this app exists.
 */
const service = () => useService('hodlr');

export interface PriceInfo {
  current: number;
  history: PricePoint[];
}

export interface Portfolio {
  quantity: number;
  currentPrice: number;
  currentValue: number;
}

export type TradeOutcome =
  | { ok: true; quantity: number; price: number; cost?: number; proceeds?: number }
  | { ok: false; reason: string };

const emptyPrice: PriceInfo = { current: 0, history: [] };
const emptyPortfolio: Portfolio = { quantity: 0, currentPrice: 0, currentValue: 0 };

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
  return { priceStore, portfolioStore, loadPrice, loadPortfolio, buy, sell };
}
