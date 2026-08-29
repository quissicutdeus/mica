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
