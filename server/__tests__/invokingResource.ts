// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Call an export the way FiveM does, as far as `GetInvokingResource` is concerned.
 *
 * FiveM answers the invoking resource only while the export call is still on the stack: once
 * the handler has yielded at its first `await`, it answers nothing useful. `setup.ts` stubs it
 * as a constant, which hides exactly the bug of reading it too late — an async export that
 * asks after an await passes against the constant and fails in game (MICA-278's review).
 *
 * `name` during the synchronous part of `run`, `''` after it, until the call settles; the
 * previous stub is restored afterwards. The same pattern `bridges.test.ts` uses for a bridge.
 */
export const callAsResource = async <T>(name: string, run: () => T): Promise<Awaited<T>> => {
  const host = globalThis as { GetInvokingResource?: () => string };
  const previous = host.GetInvokingResource;
  let onStack = true;
  host.GetInvokingResource = () => (onStack ? name : '');
  try {
    const pending = run();
    onStack = false;
    return await pending;
  } finally {
    host.GetInvokingResource = previous;
  }
};
