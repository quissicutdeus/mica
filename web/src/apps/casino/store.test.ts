// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const service = vi.hoisted(() => ({ call: vi.fn() }));
const pushes = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>()
}));

/**
 * The SDK, stubbed to the three things the store reaches for: `useService`, the translator and
 * `useAppEvents` — Hodlr's shape. The translator is the real one, by module path, so a refusal
 * assertion checks the catalog rather than a stub echoing its argument.
 */
vi.mock('@mica/sdk', async () => {
  const { t, registerMessages } = await import('../../../../sdk/i18n');
  return {
    useService: () => ({ call: service.call }),
    useAppEvents: () => ({
      on: (event: string, handler: (e: { payload: unknown }) => void) => {
        pushes.handlers.set(event, handler);
        return () => pushes.handlers.delete(event);
      }
    }),
    t,
    registerMessages
  };
});

import { registerMessages } from '@mica/sdk';
import en from './locales/en.json';
import de from './locales/de.json';

registerMessages('casino', { en, de });

import {
  bets,
  cashOut,
  config,
  crashOutcome,
  crashRound,
  history,
  lastSpin,
  loadConfig,
  chip,
  receiveCrash,
  refusalMessage,
  resumeCrash,
  spin,
  startCrash,
  thrownMessage
} from './store';

const CONFIG = { bet_min: 10, bet_max: 1000, crash_edge_pct: 3, wheel: 'european' };

/** Answer each action from a table; `history` always answers an empty page. */
const answer = (table: Record<string, unknown>) =>
  service.call.mockImplementation(async (action: string) => {
    if (action in table) {
      const reply = table[action];
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (action === 'history') return { rows: [], nextCursor: null };
    throw new Error(`unexpected ${action}`);
  });

beforeEach(() => {
  service.call.mockReset();
  config.set(CONFIG as never);
  bets.set([]);
  lastSpin.set(null);
  crashRound.set(null);
  crashOutcome.set(null);
  history.set([]);
});

describe('loading the table', () => {
  it('reads the limits and arms the smallest chip', async () => {
    config.set(null);
    chip.set(0);
    answer({ config: CONFIG });
    await loadConfig();
    expect(get(config)).toEqual(CONFIG);
    expect(get(chip)).toBe(10);
  });
});

describe('spin', () => {
  it('sends every bet in one call, clears the board, and keeps the result', async () => {
    const placed = [
      { kind: 'straight' as const, value: 17, amount: 10 },
      { kind: 'red' as const, amount: 20 }
    ];
    bets.set(placed);
    const result = { round_id: 9, number: 17, color: 'black', stake: 30, payout: 360 };
    answer({ spin: result });
    await spin();
    expect(service.call).toHaveBeenCalledWith('spin', { bets: placed });
    expect(get(bets)).toEqual([]);
    expect(get(lastSpin)).toEqual(result);
  });

  it('refuses a board the mirror rejects without asking the server', async () => {
    bets.set([{ kind: 'red', amount: 5 }]);
    await expect(spin()).rejects.toThrow('Each bet is at least $10.');
    expect(service.call).not.toHaveBeenCalled();
  });

  it('turns the server refusal slug into a sentence and keeps the board', async () => {
    const placed = [{ kind: 'red' as const, amount: 500 }];
    bets.set(placed);
    answer({ spin: new Error('insufficient_funds') });
    await expect(spin()).rejects.toThrow('Not enough money in your bank account.');
    expect(get(bets)).toEqual(placed);
  });
});

describe('refusals', () => {
  it('words a refusal the server returns rather than throws, and keeps the board', async () => {
    const placed = [{ kind: 'red' as const, amount: 500 }];
    bets.set(placed);
    answer({ spin: { ok: false, reason: 'above_max' } });
    await expect(spin()).rejects.toThrow('Bets total at most $1000.');
    expect(get(bets)).toEqual(placed);
    expect(get(lastSpin)).toBeNull();
  });

  it('never shows an unknown slug raw', () => {
    expect(refusalMessage('round_failed')).toBe('The casino did not answer. Try again.');
    expect(refusalMessage('something_new')).toBe('The casino did not answer. Try again.');
    // A Map, not an object literal: `'toString' in {}` is true.
    expect(refusalMessage('toString')).toBe('The casino did not answer. Try again.');
  });

  it('passes a thrown sentence through, and translates a thrown slug', () => {
    expect(thrownMessage(new Error('You are doing that too often.'))).toBe(
      'You are doing that too often.'
    );
    expect(thrownMessage(new Error('insufficient_funds'))).toBe(
      'Not enough money in your bank account.'
    );
    expect(thrownMessage(undefined)).toBe('The casino did not answer. Try again.');
    expect(thrownMessage(new Error('toString'))).toBe('toString');
  });
});

describe('crash', () => {
  it('starts a round measuring the clock offset once', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_500);
    answer({ crashStart: { round_id: 4, started_at: 10_000 } });
    await startCrash(100);
    expect(service.call).toHaveBeenCalledWith('crashStart', { stake: 100 });
    expect(get(crashRound)).toEqual({ round_id: 4, stake: 100, started_at: 10_000, offset: 500 });
    vi.restoreAllMocks();
  });

  it('closes an instant bust from the start reply, and ignores its push either side of it', async () => {
    answer({ crashStart: { round_id: 6, started_at: 10_000, busted: { crash_at: 100 } } });
    // In game the push can overtake the reply: it names a round that is not live yet.
    receiveCrash({ round_id: 6, crash_at: 100 });
    await startCrash(100);
    expect(get(crashRound)).toBeNull();
    const busted = { kind: 'busted', round_id: 6, stake: 100, crash_at: 100 };
    expect(get(crashOutcome)).toEqual(busted);
    // ...or it arrives after, and changes nothing.
    pushes.handlers.get('crash')?.({ payload: { round_id: 6, crash_at: 100 } });
    expect(get(crashOutcome)).toEqual(busted);
  });

  it('ends the live round on the crash push that names it', () => {
    crashRound.set({ round_id: 4, stake: 100, started_at: 0, offset: 0 });
    answer({});
    pushes.handlers.get('crash')?.({ payload: { round_id: 4, crash_at: 187 } });
    expect(get(crashRound)).toBeNull();
    expect(get(crashOutcome)).toEqual({ kind: 'busted', round_id: 4, stake: 100, crash_at: 187 });
  });

  it('ignores a push for another round, and a malformed one', () => {
    const live = { round_id: 5, stake: 100, started_at: 0, offset: 0 };
    crashRound.set(live);
    receiveCrash({ round_id: 4, crash_at: 187 });
    receiveCrash({ round_id: '5', crash_at: 187 });
    expect(get(crashRound)).toEqual(live);
    expect(get(crashOutcome)).toBeNull();
  });

  it('records a cashout the server paid', async () => {
    crashRound.set({ round_id: 4, stake: 100, started_at: 0, offset: 0 });
    answer({ crashCashout: { ok: true, multiplier: 250, payout: 250 } });
    await cashOut();
    expect(service.call).toHaveBeenCalledWith('crashCashout', { round_id: 4 });
    expect(get(crashRound)).toBeNull();
    expect(get(crashOutcome)).toEqual({
      kind: 'cashed',
      round_id: 4,
      stake: 100,
      multiplier: 250,
      payout: 250
    });
  });

  it('lets a paid cash-out win over a crash push that arrived first', async () => {
    crashRound.set({ round_id: 4, stake: 100, started_at: 0, offset: 0 });
    let reply!: (value: unknown) => void;
    service.call.mockImplementation((action: string) =>
      action === 'crashCashout'
        ? new Promise((resolve) => (reply = resolve))
        : Promise.resolve({ rows: [], nextCursor: null })
    );
    const pending = cashOut();
    // The timer busts the round while the server is still reading the cash-out...
    receiveCrash({ round_id: 4, crash_at: 180 });
    expect(get(crashOutcome)).toMatchObject({ kind: 'busted' });
    // ...and the server pays the cash-out it had already taken anyway.
    reply({ ok: true, multiplier: 175, payout: 175 });
    await pending;
    expect(get(crashRound)).toBeNull();
    expect(get(crashOutcome)).toEqual({
      kind: 'cashed',
      round_id: 4,
      stake: 100,
      multiplier: 175,
      payout: 175
    });
  });

  it('shows a cashout that lost the race as busted', async () => {
    crashRound.set({ round_id: 4, stake: 100, started_at: 0, offset: 0 });
    answer({ crashCashout: { ok: false, reason: 'busted', crash_at: 120 } });
    await cashOut();
    expect(get(crashOutcome)).toEqual({ kind: 'busted', round_id: 4, stake: 100, crash_at: 120 });
  });

  it('ends a round the server no longer holds without inventing an outcome', async () => {
    crashRound.set({ round_id: 4, stake: 100, started_at: 0, offset: 0 });
    answer({ crashCashout: { ok: false, reason: 'not_found' } });
    await cashOut();
    expect(get(crashRound)).toBeNull();
    expect(get(crashOutcome)).toEqual({ kind: 'ended', round_id: 4, stake: 100 });
  });

  it('refuses a second round while one is live, in words', async () => {
    answer({ crashStart: { ok: false, reason: 'round_active' } });
    await expect(startCrash(100)).rejects.toThrow('Finish your crash round first.');
    expect(get(crashRound)).toBeNull();
  });

  it('keeps a live round when the cashout request itself fails', async () => {
    const live = { round_id: 4, stake: 100, started_at: 0, offset: 0 };
    crashRound.set(live);
    answer({ crashCashout: new Error('Request timed out') });
    await expect(cashOut()).rejects.toThrow('Request timed out');
    expect(get(crashRound)).toEqual(live);
  });

  it('resumes a round the server still holds', async () => {
    answer({ crashState: { round_id: 7, stake: 50, started_at: 1_000 } });
    await resumeCrash();
    expect(get(crashRound)).toEqual({ round_id: 7, stake: 50, started_at: 1_000, offset: 0 });
  });

  it('keeps the measured offset when resuming the round it started', async () => {
    const live = { round_id: 7, stake: 50, started_at: 1_000, offset: 320 };
    crashRound.set(live);
    answer({ crashState: { round_id: 7, stake: 50, started_at: 1_000 } });
    await resumeCrash();
    expect(get(crashRound)).toEqual(live);
  });

  it('marks a held round ended when the server no longer has it', async () => {
    crashRound.set({ round_id: 7, stake: 50, started_at: 1_000, offset: 0 });
    answer({ crashState: null });
    await resumeCrash();
    expect(get(crashRound)).toBeNull();
    expect(get(crashOutcome)).toEqual({ kind: 'ended', round_id: 7, stake: 50 });
  });
});
