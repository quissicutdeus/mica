// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import {
  actionsOf,
  allContracts,
  contractFor,
  defineContract,
  isClientPrepared,
  responseType,
  type ActionContract,
  type ActionInput,
  type ActionOutput
} from './contract';
import { s } from './schema';

/**
 * The registry is module state, so every id here is unique to its test. Importing the real
 * contracts is what `server/__tests__/reachability.test.ts` does; this file is about the
 * declaration mechanism rather than about any one service.
 */
const sample = defineContract({
  id: 'contract-test-sample',
  actions: {
    restore: { input: s.object({ id: s.positiveInt() }), output: responseType<{ ok: boolean }>() },
    shareLocation: {
      input: s.object({ label: s.string({ max: 255 }).optional() }),
      clientPrepared: true
    }
  }
});

describe('defineContract', () => {
  it('registers under its id, so a consumer can find it without importing the file', () => {
    expect(contractFor('contract-test-sample')).toBe(sample);
    expect(allContracts()).toContain(sample);
  });

  it('enumerates its actions in a stable order', () => {
    expect(actionsOf(sample)).toEqual(['restore', 'shareLocation']);
  });

  it('says which actions the client relay has to prepare', () => {
    expect(isClientPrepared(sample, 'shareLocation')).toBe(true);
    expect(isClientPrepared(sample, 'restore')).toBe(false);
    // An action that does not exist is not "prepared" — a relay asking about one it has never
    // heard of should get `false`, not a crash on the way to a 15-second timeout.
    expect(isClientPrepared(sample, 'nonexistent')).toBe(false);
  });

  it('refuses a second contract for one service', () => {
    expect(() => defineContract({ id: 'contract-test-sample', actions: {} })).toThrow(
      /already declared/
    );
  });

  it('refuses an action with no input schema', () => {
    expect(() =>
      defineContract({
        id: 'contract-test-no-input',
        // The cast is the point: this is what a hand-written contract missing an `input`
        // looks like once it has been through a build that erased the type error.
        actions: { doThing: {} as never }
      })
    ).toThrow(/no input schema/);
  });

  it('refuses a contract with no id', () => {
    expect(() => defineContract({ id: '', actions: {} })).toThrow(/'id' is required/);
  });
});

const declarationOnly = responseType<{ ok: boolean }>();

describe('responseType is declaration-only', () => {
  it('passes any value through, because the server does not validate its own replies', () => {
    const shape = responseType<{ ok: boolean }>();
    expect(shape['~standard'].validate({ anything: true })).toEqual({
      value: { anything: true }
    });
  });

  /**
   * A compile-time assertion, and the reason `responseType` is branded at all: it validates
   * nothing, so an input position accepting one would be an action that takes anything while
   * looking like it did not. Uncommenting the line below must fail `pnpm typecheck`.
   */
  it('is not assignable to an input', () => {
    // @ts-expect-error `~responseOnly: true` is not assignable to `undefined`.
    const bad: ActionContract = { input: declarationOnly };
    expect(bad.input).toBeDefined();
  });
});

describe('the types a consumer derives', () => {
  it('gives an action its parsed input and its declared output', () => {
    // Compile-time: these only typecheck if `ActionInput` reads through `input`'s schema and
    // `ActionOutput` through `output`'s. The runtime assertion is incidental.
    const parsed: ActionInput<typeof sample, 'restore'> = { id: 4 };
    const answered: ActionOutput<typeof sample, 'restore'> = { ok: true };
    const optional: ActionInput<typeof sample, 'shareLocation'> = {};

    expect(parsed.id).toBe(4);
    expect(answered.ok).toBe(true);
    expect(optional.label).toBeUndefined();
  });

  it('falls back to unknown for an action the contract does not name', () => {
    const unnamed: ActionInput<typeof sample, 'notAnAction'> = { anything: true };
    expect(unnamed).toBeTruthy();
  });
});
