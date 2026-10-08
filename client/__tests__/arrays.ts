// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `Array.prototype.at(-1)` and `toSorted()`, for tests typechecked against the client's lib.
 *
 * `client/tsconfig.tests.json` extends `client/tsconfig.json`, whose `lib` is `es2021` because
 * that is what the game's script runtime is held to. `at` is ES2022 and `toSorted` ES2023, so
 * a test calling them runs under Node and fails the test typecheck (MICA-320). These do the
 * same thing in ES2021 terms, rather than widening the lib for the tests and letting them drift
 * from what the code under test may use.
 */

/** The last element, or `undefined` for an empty array — what `items.at(-1)` answers. */
export function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

/** A sorted copy under the default comparator, leaving `items` alone — `items.toSorted()`. */
export function sorted<T>(items: readonly T[]): T[] {
  return [...items].sort();
}
