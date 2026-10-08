// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The call shape of `Database.query` / `single` / `scalar` / `insert` / `update`, for typing a
 * hoisted `vi.fn` stand-in. A bare `vi.fn(async () => [])` infers a zero-argument signature, so
 * `mock.calls[0]` is the empty tuple `[]` and reading the SQL out of it is a type error.
 * `vi.fn<DbCall<R>>(...)` keeps the real `(sql, params)` arguments on `mock.calls`.
 *
 * Type-only, so a `vi.hoisted` block can use it: `import type` is erased before hoisting.
 */
export type DbCall<R = unknown> = (sql: string, params?: unknown[]) => Promise<R>;
