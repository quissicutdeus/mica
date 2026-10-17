// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Account } from '@mica/shared/types';
import { declaredServices } from './defineService';

/**
 * Tables a reaction may target, and the whole rule for each, declared by the service that owns
 * the table (MICA-391).
 *
 * `target_table` arrives in a NUI payload and is interpolated into SQL as a *value* bound
 * through a placeholder, not as an identifier — so this is not the injection guard
 * `REPORTABLE` is. It exists anyway because an unchecked `target_table` would let a client
 * invent a namespace and pollute reaction counts/queries for a table it has no business
 * reacting to, and because it is what makes "a table opts in to reactions" a declaration
 * rather than a hardcoded list naming an add-on's tables from core.
 *
 * The two rules used to be hand-kept maps in `services/Accounts.ts`, naming Glimpse's table from
 * core. Each now lives on its own `defineService` declaration, and core reads them back out of
 * `declaredServices` **at call time** — that registry fills as services load, so a lookup taken
 * at import would see whichever ones happened to load first.
 */
export interface ReactableDefinition {
  label: string;
  /**
   * The only emoji a reaction on this table may be, when it is not the open palette. Glimpse's
   * likes are a ❤️ and nothing else (MICA-253): a 😂 stored on a post is a reaction its UI
   * cannot draw and every count would be wrong by. Compared as exact strings, so write the
   * variation selector (U+FE0F) the palette sends — a bare U+2764 is a different string.
   * Absent means any emoji the contract admits.
   */
  emoji?: readonly string[];
  /**
   * Whether `account` — already proven the caller's, in the app the payload named — may react
   * to row `rowId`. `rowId` is the payload's, so without this any account could put a reaction
   * into any row, including a private DM between two other people (MICA-339). Answer the same
   * `false` for a row that is missing as for one that is not theirs, so the reply cannot tell a
   * stranger which ids exist.
   */
  canReact: (account: Account, rowId: number) => Promise<boolean>;
  /**
   * The ids out of a batch whose reactions this viewer may read, as `citizenid` asking in
   * `appId` (the payload's). An id left out still answers, as one with no reactions.
   */
  visibleTo: (ids: number[], citizenid: string, appId: string) => Promise<number[]>;
}

export type ReactableTable = string;

/** Every declared reactable table and its rule, read from the declarations as they stand now. */
export const reactableTables = (): Map<ReactableTable, ReactableDefinition> =>
  new Map(
    declaredServices.flatMap((service) =>
      service.reactable ? [[service.table, service.reactable] as const] : []
    )
  );

/** The declared rule for `table`, or undefined when no service declared it reactable. */
export const reactableRule = (table: unknown): ReactableDefinition | undefined =>
  typeof table === 'string'
    ? (declaredServices.find((service) => service.table === table)?.reactable ?? undefined)
    : undefined;

export const isReactableTable = (table: unknown): table is ReactableTable =>
  reactableRule(table) !== undefined;
