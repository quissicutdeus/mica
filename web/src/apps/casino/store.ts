// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { formatCurrency, t, useAppEvents, useService } from '@mica/sdk';
import type { CasinoCrashRound, CasinoRound, CasinoSpinResult } from '@mica/shared/types';
import {
  MAX_BETS,
  betProblem,
  chipValues,
  stakeProblem,
  type Bet,
  type CasinoConfig
} from './rules';

/**
 * The Casino's data layer (MICA-82), inside the app for Hodlr's reason: an add-on cannot put a
 * store in core or a hook in the SDK.
 *
 * Every action goes through `useService('casino')`, untyped, because the contract lives beside
 * its `defineService` in `server/services/Casino.ts` — an add-on's id may not be named in
 * `shared/`. Resolved per call: a handle captured at module scope closes over the transport as
 * it was at import time.
 */
const service = () => useService('casino');

export type { Bet, CasinoConfig } from './rules';
export type { CasinoRound } from '@mica/shared/types';

/**
 * A crash round in flight. `offset` is `Date.now() − started_at`, taken once when the round
 * starts, so the curve runs from the moment the answer arrived on this machine's clock rather
 * than trusting the two clocks to agree.
 */
export interface LiveCrash extends CasinoCrashRound {
  offset: number;
}

export type CrashOutcome =
  | { kind: 'cashed'; round_id: number; stake: number; multiplier: number; payout: number }
  | { kind: 'busted'; round_id: number; stake: number; crash_at: number }
  /** The round ended while the phone was not looking, and the push is gone. */
  | { kind: 'ended'; round_id: number; stake: number };

/**
 * A refusal, which the server **returns** rather than throws (`CasinoRefusal` in
 * `server/services/Casino.ts`), so the app words it itself.
 */
interface Refusal {
  ok: false;
  reason: string;
}

/** `crashStart`'s answer. `busted` is there only on an instant bust, which never runs. */
type CrashStarted = Pick<CasinoCrashRound, 'round_id' | 'started_at'> & {
  busted?: { crash_at: number };
};

type CashoutAnswer =
  | { ok: true; multiplier: number; payout: number }
  | { ok: false; reason: 'busted'; crash_at: number }
  | { ok: false; reason: 'not_found' };

const isRefusal = (reply: unknown): reply is Refusal =>
  typeof reply === 'object' &&
  reply !== null &&
  (reply as { ok?: unknown }).ok === false &&
  typeof (reply as { reason?: unknown }).reason === 'string';

// ── State ──────────────────────────────────────────────────────────────────────────

export const config = writable<CasinoConfig | null>(null);
/** The chip the next tap on the board places. */
export const chip = writable(0);
export const bets = writable<readonly Bet[]>([]);
/** What the last spin staked, for Rebet. */
export const lastBets = writable<readonly Bet[]>([]);
export const lastSpin = writable<CasinoSpinResult | null>(null);

export const crashRound = writable<LiveCrash | null>(null);
export const crashOutcome = writable<CrashOutcome | null>(null);

export const history = writable<CasinoRound[]>([]);
export const historyCursor = writable<number | null>(null);
export const historyLoaded = writable(false);

const HISTORY_PAGE = 20;

// ── Refusals ───────────────────────────────────────────────────────────────────────

/** Every slug the server's refusals and the client's mirror can name. */
const REFUSALS = new Map<string, string>([
  ['insufficient_funds', 'casino.failInsufficientFunds'],
  ['debit_failed', 'casino.failBankRefused'],
  ['invalid_bet', 'casino.failInvalid'],
  ['invalid_args', 'casino.failInvalid'],
  ['round_active', 'casino.failRoundActive'],
  ['round_failed', 'casino.failGeneric'],
  ['not_found', 'casino.failRoundGone'],
  ['no_bets', 'casino.failNoBets'],
  ['too_many_bets', 'casino.failTooManyBets'],
  ['below_min', 'casino.failBelowMin'],
  ['above_max', 'casino.failAboveMax']
]);

/**
 * A refusal slug in words. An unknown slug reads as a generic failure rather than being shown
 * raw: a new server-side reason should look like a failure, not debug output (Hodlr's MICA-99).
 */
export const refusalMessage = (reason: string): string => {
  const translate = get(t);
  const limits = get(config);
  return translate(REFUSALS.get(reason) ?? 'casino.failGeneric', {
    min: formatCurrency(limits?.bet_min ?? 0),
    max: formatCurrency(limits?.bet_max ?? 0),
    count: MAX_BETS
  });
};

/**
 * A thrown failure in words: a rate limit, a timeout, a translated `ServiceRefusal` — already a
 * sentence, shown as it came, unless it is one of the slugs above.
 */
export const thrownMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return REFUSALS.has(message) || !message ? refusalMessage(message) : message;
};

/** Ask the server, and turn either kind of refusal into an `Error` carrying a sentence. */
const ask = async <T>(action: string, input: unknown): Promise<T> => {
  let reply: unknown;
  try {
    reply = await service().call<unknown>(action, input);
  } catch (error) {
    throw new Error(thrownMessage(error));
  }
  if (isRefusal(reply)) throw new Error(refusalMessage(reply.reason));
  return reply as T;
};

// ── Loading ────────────────────────────────────────────────────────────────────────

/** Never rejects; it runs from `onAppForeground`. A failed read keeps what was held. */
export const loadConfig = async (): Promise<void> => {
  try {
    const next = await service().call<CasinoConfig>('config', {});
    config.set(next);
    const chips = chipValues(next);
    if (!chips.includes(get(chip))) chip.set(chips[0] ?? 0);
  } catch (error) {
    console.warn('micaOS Casino: could not load the table limits', error);
  }
};

export const loadHistory = async (): Promise<void> => {
  try {
    const page = await service().call<{ rows: CasinoRound[]; nextCursor: number | null }>(
      'history',
      { limit: HISTORY_PAGE }
    );
    history.set(page.rows);
    historyCursor.set(page.nextCursor ?? null);
    historyLoaded.set(true);
  } catch (error) {
    console.warn('micaOS Casino: could not load your history', error);
  }
};

export const loadMoreHistory = async (): Promise<void> => {
  const cursor = get(historyCursor);
  if (cursor === null) return;
  try {
    const page = await service().call<{ rows: CasinoRound[]; nextCursor: number | null }>(
      'history',
      { cursor, limit: HISTORY_PAGE }
    );
    history.update((rows) => [
      ...rows,
      ...page.rows.filter((r) => !rows.some((held) => held.id === r.id))
    ]);
    historyCursor.set(page.nextCursor ?? null);
  } catch (error) {
    console.warn('micaOS Casino: could not load older rounds', error);
  }
};

/**
 * Pick up a crash round the server still holds — the app was closed mid-round, or the phone
 * was. A round this phone started keeps the offset it measured; one it never saw start has no
 * measurement to keep, so it runs on the server's clock as-is (offset 0).
 *
 * The server answering `null` while one is held here means the round ended while nobody was
 * looking: the push went to a closed phone. The outcome is in history, not here.
 */
export const resumeCrash = async (): Promise<void> => {
  let state: CasinoCrashRound | null;
  try {
    state = await service().call<typeof state>('crashState', {});
  } catch (error) {
    console.warn('micaOS Casino: could not check for a live round', error);
    return;
  }
  const held = get(crashRound);
  if (state) {
    if (held?.round_id === state.round_id) return;
    crashRound.set({ ...state, offset: 0 });
    crashOutcome.set(null);
  } else if (held) {
    crashRound.set(null);
    crashOutcome.set({ kind: 'ended', round_id: held.round_id, stake: held.stake });
  }
};

/** Everything the app reads on each visit. Never rejects. */
export const refresh = (): Promise<unknown> =>
  Promise.all([loadConfig(), resumeCrash(), loadHistory()]);

// ── Roulette ───────────────────────────────────────────────────────────────────────

/**
 * Send every bet on the board in one `spin`. Throws a sentence on a refusal — the caller wraps
 * it in `useAppAction().run`, which toasts it. The board clears only once the server took it.
 */
export const spin = async (): Promise<CasinoSpinResult> => {
  const placed = get(bets);
  const limits = get(config);
  if (!limits) throw new Error(refusalMessage(''));
  const problem = betProblem(placed, limits);
  if (problem) throw new Error(refusalMessage(problem));
  const result = await ask<CasinoSpinResult>('spin', { bets: placed });
  lastBets.set(placed);
  bets.set([]);
  lastSpin.set(result);
  void loadHistory();
  return result;
};

// ── Crash ──────────────────────────────────────────────────────────────────────────

export const startCrash = async (stake: number): Promise<void> => {
  const limits = get(config);
  if (!limits) throw new Error(refusalMessage(''));
  const problem = stakeProblem(stake, limits);
  if (problem) throw new Error(refusalMessage(problem));
  const started = await ask<CrashStarted>('crashStart', { stake });
  if (started.busted) {
    // An instant bust: the round was settled at 1.00× before the reply left the server, and the
    // `crash` push may already have come and gone — it can overtake the reply in game. It never
    // becomes the live round, so `receiveCrash` finds nothing to end when that push does arrive.
    crashRound.set(null);
    crashOutcome.set({
      kind: 'busted',
      round_id: started.round_id,
      stake,
      crash_at: started.busted.crash_at
    });
  } else {
    crashOutcome.set(null);
    crashRound.set({
      round_id: started.round_id,
      started_at: started.started_at,
      stake,
      offset: Date.now() - started.started_at
    });
  }
  void loadHistory();
};

/**
 * Cash out the live round. The answer is the server's word on where it stood: a cashout that
 * lost the race to the crash answers `busted`, and that is what the player sees. `not_found`
 * is a round the server no longer holds as in play — settled by a restart's sweep, or already
 * answered — so the round ends here without an outcome to show, and History has it.
 *
 * A request that failed outright (a timeout, a rate limit) throws and leaves the round live:
 * the player can try again while the curve still climbs.
 */
export const cashOut = async (): Promise<void> => {
  const round = get(crashRound);
  if (!round) return;
  let answer: CashoutAnswer;
  try {
    answer = await service().call<CashoutAnswer>('crashCashout', { round_id: round.round_id });
  } catch (error) {
    throw new Error(thrownMessage(error));
  }
  const { round_id, stake } = round;
  if (get(crashRound)?.round_id === round_id) crashRound.set(null);
  crashOutcome.set(
    answer.ok
      ? { kind: 'cashed', round_id, stake, multiplier: answer.multiplier, payout: answer.payout }
      : answer.reason === 'busted'
        ? { kind: 'busted', round_id, stake, crash_at: answer.crash_at }
        : { kind: 'ended', round_id, stake }
  );
  void loadHistory();
};

/**
 * The server's `crash` push: the round with this id is over. It ends the live round only when
 * it names it — a replayed push for an older round, or one this phone already cashed out of,
 * changes nothing on screen.
 */
export const receiveCrash = (payload: { round_id?: unknown; crash_at?: unknown }): void => {
  const { round_id, crash_at } = payload;
  if (typeof round_id !== 'number' || typeof crash_at !== 'number') return;
  const round = get(crashRound);
  if (round?.round_id !== round_id) return;
  crashRound.set(null);
  crashOutcome.set({ kind: 'busted', round_id, stake: round.stake, crash_at });
  void loadHistory();
};

// In the store, not a component: a push that arrives while the app is backgrounded still ends
// the round, and the subscription outlives any one screen.
useAppEvents('casino').on<{ round_id?: unknown; crash_at?: unknown }>('crash', (event) =>
  receiveCrash(event.payload)
);
