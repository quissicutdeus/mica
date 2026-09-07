// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/Database', () => ({
  Database: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));

import { BankingBridge } from '../lib/BankingBridge';
import { payFromSociety } from '../lib/Payments';
import { __setResourceLookup } from '../lib/FrameworkBridge';

/**
 * Society money (MICA-227).
 *
 * `BankingBridge`'s society half against a fake Renewed-Banking shaped the way the vendored
 * `server/main.lua` answers — `false` for an unknown account, a boolean from every write —
 * and `payFromSociety` on top of it, including the refund and the stranded case. The bridge
 * reaches the resource through `framework/runtime.ts`'s `resource()` seam, which is what
 * lets a test stand in for `exports['Renewed-Banking']` at all; `BankingBridge.test.ts`
 * explains why the transactions read could not be covered the same way before that seam.
 */

/** A fake Renewed-Banking whose society accounts are observable. */
const makeRenewed = (accounts: Record<string, number>, opts: { canAdd?: boolean } = {}) => {
  const state = { ...accounts };
  return {
    getAccountMoney: (account: string) => (account in state ? state[account] : false),
    removeAccountMoney: (account: string, amount: number) => {
      if (!(account in state) || state[account] < amount) return false;
      state[account] -= amount;
      return true;
    },
    addAccountMoney: (account: string, amount: number) => {
      if (!(account in state) || opts.canAdd === false) return false;
      state[account] += amount;
      return true;
    },
    read: (account: string) => state[account]
  };
};

/** A fake framework player whose bank balance is observable. */
const makePlayer = (citizenid: string, balance: number, opts: { canAdd?: boolean } = {}) => {
  const state = { bank: balance };
  return {
    PlayerData: { citizenid, charinfo: { phone: '555' } },
    Functions: {
      GetMoney: () => state.bank,
      RemoveMoney: () => false,
      AddMoney: (_t: string, amount: number) => {
        if (opts.canAdd === false) return false;
        state.bank += amount;
        return true;
      }
    },
    read: () => state.bank
  };
};

const install = (
  renewed: ReturnType<typeof makeRenewed> | Record<string, unknown> | undefined,
  players: Record<number, ReturnType<typeof makePlayer>> = {}
) =>
  __setResourceLookup((name) => {
    if (name === 'Renewed-Banking') return renewed;
    if (name === 'qbx_core') {
      return { GetPlayer: (src: number) => players[src] ?? null, GetQBPlayers: () => players };
    }
    return undefined;
  });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __setResourceLookup();
  vi.restoreAllMocks();
});

describe('BankingBridge society reads', () => {
  it('reads a society balance from Renewed-Banking', () => {
    install(makeRenewed({ police: 12_000 }));
    expect(BankingBridge.getSocietyBalance('police')).toBe(12_000);
  });

  it('answers null, not 0, when no banking resource is running', () => {
    // A Jobs app reading 0 would tell a boss the account is empty; the truth is that nobody
    // can say, and the two need different screens.
    install(undefined);
    expect(BankingBridge.getSocietyBalance('police')).toBeNull();
  });

  it('answers null for the `false` Renewed sends for an account it has not cached', () => {
    install(makeRenewed({ police: 12_000 }));
    expect(BankingBridge.getSocietyBalance('taxi')).toBeNull();
  });

  it('refuses a shapeless answer as unknown, and says so', () => {
    install({ getAccountMoney: () => ({ amount: 500 }) });
    expect(BankingBridge.getSocietyBalance('police')).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('rather than a number'));
  });

  it('answers null for a job name that is not a job name', () => {
    const renewed = makeRenewed({ police: 12_000 });
    const spy = vi.spyOn(renewed, 'getAccountMoney');
    install(renewed);
    expect(BankingBridge.getSocietyBalance('Police; DROP')).toBeNull();
    expect(BankingBridge.getSocietyBalance('')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers null rather than throwing when the resource throws', () => {
    install({
      getAccountMoney: () => {
        throw new Error('resource stopped');
      }
    });
    expect(BankingBridge.getSocietyBalance('police')).toBeNull();
  });

  it('leaves detect() answering by the transactions export alone', () => {
    // The startup line names a banking resource by what the Bank app needs; a society-only
    // fake is not one.
    install({ getAccountMoney: () => 5 });
    expect(BankingBridge.detect()).toBeNull();
  });
});

describe('BankingBridge society moves', () => {
  it('debits and credits an account, believing only a literal true', () => {
    const renewed = makeRenewed({ police: 1_000 });
    install(renewed);

    expect(BankingBridge.removeSocietyMoney('police', 300)).toBe(true);
    expect(renewed.read('police')).toBe(700);
    expect(BankingBridge.addSocietyMoney('police', 50)).toBe(true);
    expect(renewed.read('police')).toBe(750);
  });

  it('reports the refusal Renewed answers for an overdraw or an unknown account', () => {
    const renewed = makeRenewed({ police: 100 });
    install(renewed);

    expect(BankingBridge.removeSocietyMoney('police', 300)).toBe(false);
    expect(BankingBridge.removeSocietyMoney('taxi', 1)).toBe(false);
    expect(renewed.read('police')).toBe(100);
  });

  it('treats a promise or an object from a write as no move', () => {
    // The `moved` rule: a renamed or async-ified export must read as refused, never as paid.
    install({
      getAccountMoney: () => 100,
      removeAccountMoney: async () => true,
      addAccountMoney: () => ({ ok: true })
    });
    expect(BankingBridge.removeSocietyMoney('police', 10)).toBe(false);
    expect(BankingBridge.addSocietyMoney('police', 10)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('a promise'));
  });

  it('refuses a non-positive or fractional amount before reaching the resource', () => {
    const renewed = makeRenewed({ police: 1_000 });
    const spy = vi.spyOn(renewed, 'removeAccountMoney');
    install(renewed);

    expect(BankingBridge.removeSocietyMoney('police', 0)).toBe(false);
    expect(BankingBridge.removeSocietyMoney('police', -5)).toBe(false);
    expect(BankingBridge.removeSocietyMoney('police', 1.5)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers false with nothing to move through', () => {
    install(undefined);
    expect(BankingBridge.removeSocietyMoney('police', 10)).toBe(false);
    expect(BankingBridge.addSocietyMoney('police', 10)).toBe(false);
  });
});

describe('payFromSociety', () => {
  it('debits the society and credits the player', async () => {
    const renewed = makeRenewed({ police: 1_000 });
    const payee = makePlayer('CIT_B', 100);
    install(renewed, { 2: payee });

    const result = await payFromSociety({ job: 'police', to: 'CIT_B', amount: 250, reason: 'pay' });

    expect(result).toEqual({ ok: true, from: 'society:police', to: 'CIT_B', amount: 250 });
    expect(renewed.read('police')).toBe(750);
    expect(payee.read()).toBe(350);
  });

  it('refunds the society when the credit fails', async () => {
    const renewed = makeRenewed({ police: 1_000 });
    const payee = makePlayer('CIT_B', 100, { canAdd: false });
    install(renewed, { 2: payee });

    const result = await payFromSociety({ job: 'police', to: 'CIT_B', amount: 250, reason: 'pay' });

    expect(result).toEqual({ ok: false, reason: 'credit_failed' });
    expect(renewed.read('police')).toBe(1_000);
    expect(payee.read()).toBe(100);
  });

  it('reports stranded money loudly when the refund also fails', async () => {
    const renewed = makeRenewed({ police: 1_000 }, { canAdd: false });
    const payee = makePlayer('CIT_B', 100, { canAdd: false });
    install(renewed, { 2: payee });

    const result = await payFromSociety({ job: 'police', to: 'CIT_B', amount: 250, reason: 'pay' });

    expect(result).toEqual({ ok: false, reason: 'stranded' });
    expect(renewed.read('police')).toBe(750);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('STRANDED'));
  });

  it('refuses rather than clamping when the society cannot afford it', async () => {
    const renewed = makeRenewed({ police: 100 });
    const payee = makePlayer('CIT_B', 0);
    install(renewed, { 2: payee });

    const result = await payFromSociety({ job: 'police', to: 'CIT_B', amount: 250, reason: 'pay' });

    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(renewed.read('police')).toBe(100);
    expect(payee.read()).toBe(0);
  });

  it('distinguishes an absent banking resource from an empty account', async () => {
    const payee = makePlayer('CIT_B', 0);
    install(undefined, { 2: payee });

    const result = await payFromSociety({ job: 'police', to: 'CIT_B', amount: 50, reason: 'pay' });

    expect(result).toEqual({ ok: false, reason: 'society_unavailable' });
    expect(payee.read()).toBe(0);
  });

  it('treats a job with no account as unavailable, and touches nothing', async () => {
    const renewed = makeRenewed({ police: 1_000 });
    const payee = makePlayer('CIT_B', 0);
    install(renewed, { 2: payee });

    const result = await payFromSociety({ job: 'taxi', to: 'CIT_B', amount: 50, reason: 'pay' });

    expect(result).toEqual({ ok: false, reason: 'society_unavailable' });
    expect(payee.read()).toBe(0);
  });

  it('refuses an offline recipient before touching the society', async () => {
    const renewed = makeRenewed({ police: 1_000 });
    install(renewed);

    const result = await payFromSociety({
      job: 'police',
      to: 'CIT_GONE',
      amount: 50,
      reason: 'pay'
    });

    expect(result).toEqual({ ok: false, reason: 'recipient_offline' });
    expect(renewed.read('police')).toBe(1_000);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('refuses %s as an amount', async (amount) => {
    const renewed = makeRenewed({ police: 1_000 });
    const payee = makePlayer('CIT_B', 0);
    install(renewed, { 2: payee });

    const result = await payFromSociety({ job: 'police', to: 'CIT_B', amount, reason: 'pay' });

    expect(result).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(renewed.read('police')).toBe(1_000);
  });

  it('runs the balance check and the debit in one synchronous span', async () => {
    // The MICA-134 invariant, exercised rather than only scanned: a second payment for the
    // same account issued before the first resolves must still see the first debit. Both
    // calls run their check-and-debit before either yields, so the second is refused.
    const renewed = makeRenewed({ police: 300 });
    const payee = makePlayer('CIT_B', 0);
    install(renewed, { 2: payee });

    const first = payFromSociety({ job: 'police', to: 'CIT_B', amount: 200, reason: 'a' });
    const second = payFromSociety({ job: 'police', to: 'CIT_B', amount: 200, reason: 'b' });
    const results = await Promise.all([first, second]);

    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(renewed.read('police')).toBe(100);
    expect(payee.read()).toBe(200);
  });
});
