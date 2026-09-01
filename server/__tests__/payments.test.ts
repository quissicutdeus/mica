// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/Database', () => ({
  Database: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));

import { transfer } from '../lib/Payments';
import { FrameworkBridge, __setResourceLookup } from '../lib/FrameworkBridge';

/**
 * Paying a player.
 *
 * `FrameworkPlayer` had `getMoney` and `removeMoney` and no `addMoney`, so money could only
 * flow out of a player and a marketplace was a noticeboard. These cover the credit itself and,
 * more importantly, every way `transfer` refuses — the outcome is a discriminated union
 * specifically so a caller cannot read "the seller was offline" as "the seller was paid".
 */

/** A fake framework player whose balances are observable. */
const makePlayer = (citizenid: string, balance: number, opts: { canAdd?: boolean } = {}) => {
  const state = { bank: balance };
  return {
    PlayerData: { citizenid, charinfo: { phone: '555' } },
    Functions: {
      GetMoney: () => state.bank,
      RemoveMoney: (_t: string, amount: number) => {
        if (state.bank < amount) return false;
        state.bank -= amount;
        return true;
      },
      AddMoney: (_t: string, amount: number) => {
        if (opts.canAdd === false) return false;
        state.bank += amount;
        return true;
      }
    },
    read: () => state.bank
  };
};

const install = (players: Record<number, ReturnType<typeof makePlayer>>) => {
  __setResourceLookup((name) =>
    name === 'qbx_core'
      ? { GetPlayer: (src: number) => players[src] ?? null, GetQBPlayers: () => players }
      : undefined
  );
};

describe('transfer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __setResourceLookup();
    vi.restoreAllMocks();
  });

  it('moves money from one player to the other', async () => {
    const payer = makePlayer('CIT_A', 500);
    const payee = makePlayer('CIT_B', 100);
    install({ 1: payer, 2: payee });

    const result = await transfer({ from: 'CIT_A', to: 'CIT_B', amount: 250, reason: 'sale' });

    expect(result).toEqual({ ok: true, from: 'CIT_A', to: 'CIT_B', amount: 250 });
    expect(payer.read()).toBe(250);
    expect(payee.read()).toBe(350);
  });

  it('refunds the payer when the credit fails, rather than keeping the debit', async () => {
    const payer = makePlayer('CIT_A', 500);
    const payee = makePlayer('CIT_B', 100, { canAdd: false });
    install({ 1: payer, 2: payee });

    const result = await transfer({ from: 'CIT_A', to: 'CIT_B', amount: 250, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'credit_failed' });
    // The whole point of the compensating write: the payer is whole again.
    expect(payer.read()).toBe(500);
    expect(payee.read()).toBe(100);
  });

  it('reports stranded money loudly when the refund also fails', async () => {
    // The one outcome retrying cannot fix: debited, nobody credited. It has to be
    // distinguishable from an ordinary failed credit, because it needs a human.
    const payer = makePlayer('CIT_A', 500, { canAdd: false });
    const payee = makePlayer('CIT_B', 100, { canAdd: false });
    install({ 1: payer, 2: payee });

    const result = await transfer({ from: 'CIT_A', to: 'CIT_B', amount: 250, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'stranded' });
    expect(payer.read()).toBe(250);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('STRANDED'));
  });

  it('refuses rather than clamping when the payer cannot afford it', async () => {
    // Checked before debiting: frameworks disagree about whether an overdraw returns false or
    // clamps to zero, and clamping would move less than the credit adds.
    const payer = makePlayer('CIT_A', 100);
    const payee = makePlayer('CIT_B', 0);
    install({ 1: payer, 2: payee });

    const result = await transfer({ from: 'CIT_A', to: 'CIT_B', amount: 250, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(payer.read()).toBe(100);
    expect(payee.read()).toBe(0);
  });

  it('refuses an offline recipient instead of dropping the payment', async () => {
    // A real restriction, not an oversight: crediting an offline player would mean writing the
    // framework's own players table, which §10 forbids. Refusing beats pretending.
    const payer = makePlayer('CIT_A', 500);
    install({ 1: payer });

    const result = await transfer({ from: 'CIT_A', to: 'CIT_GONE', amount: 50, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'recipient_offline' });
    expect(payer.read()).toBe(500);
  });

  it('refuses an offline payer before touching anything', async () => {
    const payee = makePlayer('CIT_B', 100);
    install({ 2: payee });

    const result = await transfer({ from: 'CIT_GONE', to: 'CIT_B', amount: 50, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'payer_offline' });
    expect(payee.read()).toBe(100);
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['fractional', 12.5]
  ])('refuses a %s amount', async (_label, amount) => {
    install({ 1: makePlayer('CIT_A', 500), 2: makePlayer('CIT_B', 0) });

    await expect(transfer({ from: 'CIT_A', to: 'CIT_B', amount, reason: 'x' })).resolves.toEqual({
      ok: false,
      reason: 'invalid_amount'
    });
  });

  it('refuses a self-transfer', async () => {
    // Not merely pointless: through two independent calls it can round-trip via a failed
    // credit and leave the player down the amount.
    install({ 1: makePlayer('CIT_A', 500) });

    await expect(
      transfer({ from: 'CIT_A', to: 'CIT_A', amount: 10, reason: 'x' })
    ).resolves.toEqual({ ok: false, reason: 'same_player' });
  });
});

/**
 * The same transfers on ESX (MICA-150).
 *
 * Worth running end to end rather than trusting the bridge unit tests, because ESX is where
 * `transfer`'s assumptions are least obviously true. It debits, credits, and refunds the debit
 * if the credit fails — and on ESX none of those three calls answers whether it worked. The
 * bridge reads the balance back instead, so what is actually being asserted here is that
 * `transfer`'s compensating logic still lands correctly when its booleans come from an
 * observation rather than from the framework's word.
 */
describe('transfer on ESX', () => {
  /** An `xPlayer` whose accounts move and whose money calls return nothing, like ESX's. */
  const makeEsxPlayer = (
    identifier: string,
    balance: number,
    opts: { canAdd?: boolean; source?: number } = {}
  ) => {
    const accounts: Record<string, number> = { bank: balance, money: 0 };
    return {
      identifier,
      source: opts.source ?? 1,
      variables: { firstName: 'Ada', lastName: 'Lovelace', phoneNumber: '555' },
      get: (key: string) => ({ firstName: 'Ada', lastName: 'Lovelace', phoneNumber: '555' })[key],
      getName: () => 'Ada Lovelace',
      getAccount: (name: string) => ({ name, money: accounts[name] }),
      // Returns nothing at all, which is ESX's real contract and the whole reason the bridge
      // reads the balance back rather than believing an answer.
      addAccountMoney: (name: string, amount: number) => {
        if (opts.canAdd === false) return;
        accounts[name] += amount;
      },
      removeAccountMoney: (name: string, amount: number) => {
        accounts[name] -= amount;
      },
      read: () => accounts.bank
    };
  };

  const installEsx = (players: Record<number, ReturnType<typeof makeEsxPlayer>>) =>
    __setResourceLookup((name) =>
      name === 'es_extended'
        ? {
            getSharedObject: () => ({
              GetPlayerFromId: (src: number) => players[src] ?? null,
              GetExtendedPlayers: () => Object.values(players)
            })
          }
        : undefined
    );

  const PAYER = 'license:aaa';
  const PAYEE = 'license:bbb';

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __setResourceLookup();
    vi.restoreAllMocks();
  });

  it('moves money between two ESX players', () => {
    const payer = makeEsxPlayer(PAYER, 500, { source: 1 });
    const payee = makeEsxPlayer(PAYEE, 100, { source: 2 });
    installEsx({ 1: payer, 2: payee });

    return expect(
      transfer({ from: PAYER, to: PAYEE, amount: 250, reason: 'sale' })
    ).resolves.toEqual({ ok: true, from: PAYER, to: PAYEE, amount: 250 });
  });

  it('leaves both accounts where the transfer put them', async () => {
    const payer = makeEsxPlayer(PAYER, 500, { source: 1 });
    const payee = makeEsxPlayer(PAYEE, 100, { source: 2 });
    installEsx({ 1: payer, 2: payee });

    await transfer({ from: PAYER, to: PAYEE, amount: 250, reason: 'sale' });

    expect(payer.read()).toBe(250);
    expect(payee.read()).toBe(350);
  });

  it('refunds the payer when the credit silently does nothing', async () => {
    // The ESX-specific version of the MICA-133 failure: `addAccountMoney` returns nothing
    // whether it worked or not, so the only thing that distinguishes a credit from a no-op is
    // the balance. If the bridge trusted the call, this test would end with the payer down 250
    // and the payee unchanged — money destroyed rather than moved.
    const payer = makeEsxPlayer(PAYER, 500, { source: 1 });
    const payee = makeEsxPlayer(PAYEE, 100, { source: 2, canAdd: false });
    installEsx({ 1: payer, 2: payee });

    const result = await transfer({ from: PAYER, to: PAYEE, amount: 250, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'credit_failed' });
    expect(payer.read()).toBe(500);
    expect(payee.read()).toBe(100);
  });

  it('reports stranded money when the refund silently does nothing either', async () => {
    const payer = makeEsxPlayer(PAYER, 500, { source: 1, canAdd: false });
    const payee = makeEsxPlayer(PAYEE, 100, { source: 2, canAdd: false });
    installEsx({ 1: payer, 2: payee });

    const result = await transfer({ from: PAYER, to: PAYEE, amount: 250, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'stranded' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('STRANDED'));
  });

  it('refuses rather than overdrawing, which ESX itself would allow', async () => {
    // `removeAccountMoney` takes an ESX account negative without complaint — unlike qb's
    // `RemoveMoney`, which answers false. `transfer` checks `getMoney` first for exactly this
    // reason, so the refusal lands before anything moves.
    const payer = makeEsxPlayer(PAYER, 100, { source: 1 });
    const payee = makeEsxPlayer(PAYEE, 0, { source: 2 });
    installEsx({ 1: payer, 2: payee });

    const result = await transfer({ from: PAYER, to: PAYEE, amount: 250, reason: 'sale' });

    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(payer.read()).toBe(100);
  });

  it('refuses a transfer to an offline ESX player', () => {
    installEsx({ 1: makeEsxPlayer(PAYER, 500, { source: 1 }) });

    return expect(
      transfer({ from: PAYER, to: 'license:gone', amount: 50, reason: 'sale' })
    ).resolves.toEqual({ ok: false, reason: 'recipient_offline' });
  });

  it('refuses everything when the balance cannot be read at all', async () => {
    // A build whose `getAccount` has changed shape: the bridge reports the balance as
    // undeterminable, which reads as unaffordable, so `transfer` stops at its existing
    // insufficient-funds branch rather than debiting into the dark.
    const broken = { ...makeEsxPlayer(PAYER, 500, { source: 1 }), getAccount: () => undefined };
    installEsx({ 1: broken as any, 2: makeEsxPlayer(PAYEE, 0, { source: 2 }) });

    await expect(transfer({ from: PAYER, to: PAYEE, amount: 50, reason: 'sale' })).resolves.toEqual(
      { ok: false, reason: 'insufficient_funds' }
    );
  });
});

describe('addMoney on the bridge', () => {
  afterEach(() => __setResourceLookup());

  it('credits through the framework when it offers a handler', () => {
    const player = makePlayer('CIT_A', 100);
    __setResourceLookup((name) => (name === 'qbx_core' ? { GetPlayer: () => player } : undefined));

    expect(FrameworkBridge.getPlayer(1)?.addMoney('bank', 50)).toBe(true);
    expect(player.read()).toBe(150);
  });

  it('fails closed when the framework offers none', () => {
    // Not the fail-open pattern removeInventoryItem uses. That trade is defensible for a
    // consumable whose effect already happened; for money it would mean inventing currency.
    __setResourceLookup((name) =>
      name === 'qbx_core'
        ? { GetPlayer: () => ({ PlayerData: { citizenid: 'CIT_A' }, Functions: {} }) }
        : undefined
    );

    expect(FrameworkBridge.getPlayer(1)?.addMoney('bank', 50)).toBe(false);
  });
});

/**
 * MICA-133: what `transfer` does when the framework's contract moves under it.
 *
 * gPhone pins `@citizenfx/*` exactly and pins neither qbx_core nor qb-core — those are the
 * operator's own resources, upgraded on the operator's schedule. So "RemoveMoney went async"
 * is not a hypothetical, it is a Tuesday. These drive `transfer` end to end through a bridge
 * fed a framework that answers with something other than a boolean, and assert the refusal
 * lands *before* anybody is credited.
 */
describe('transfer against a framework that changed its answers', () => {
  const raw = (citizenid: string, Functions: Record<string, unknown>) => ({
    PlayerData: { citizenid, charinfo: { phone: '555' } },
    Functions
  });

  const install = (players: Record<number, unknown>) =>
    __setResourceLookup((name) =>
      name === 'qbx_core'
        ? { GetPlayer: (src: number) => players[src] ?? null, GetQBPlayers: () => players }
        : undefined
    );

  const pay = () => transfer({ from: 'CIT_A', to: 'CIT_B', amount: 250, reason: 'sale' });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __setResourceLookup();
    vi.restoreAllMocks();
  });

  it('refuses the debit when RemoveMoney answers with a promise, and credits nobody', async () => {
    // The headline case. A promise is truthy, so `if (!payer.removeMoney(...))` never tripped
    // and the payee was credited whether or not the debit resolved. That is money creation.
    const RemoveMoney = vi.fn(() => Promise.resolve(true));
    const AddMoney = vi.fn(() => true);
    install({
      1: raw('CIT_A', { GetMoney: () => 500, RemoveMoney }),
      2: raw('CIT_B', { GetMoney: () => 100, AddMoney })
    });

    await expect(pay()).resolves.toEqual({ ok: false, reason: 'debit_failed' });
    expect(RemoveMoney).toHaveBeenCalled();
    expect(AddMoney).not.toHaveBeenCalled();
  });

  it.each([
    ['a promise', () => Promise.resolve(500)],
    ['undefined', () => undefined],
    ['NaN', () => NaN]
  ])(
    'refuses before debiting when GetMoney answers with %s',
    async (_label, GetMoney: () => unknown) => {
      // `Promise < 250` and `undefined < 250` are both `false`, so the insufficient-funds
      // check passed and execution fell straight through to the debit.
      const RemoveMoney = vi.fn(() => true);
      const AddMoney = vi.fn(() => true);
      install({
        1: raw('CIT_A', { GetMoney, RemoveMoney }),
        2: raw('CIT_B', { GetMoney: () => 100, AddMoney })
      });

      await expect(pay()).resolves.toEqual({ ok: false, reason: 'insufficient_funds' });
      expect(RemoveMoney).not.toHaveBeenCalled();
      expect(AddMoney).not.toHaveBeenCalled();
    }
  );
});
