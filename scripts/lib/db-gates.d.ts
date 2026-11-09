// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `db-gates.js`, a plain JS build module. */

export interface DbGate {
  name: string;
  script: string;
  seconds: number;
  optIn?: boolean;
}
export type DbAvailability = { ok: true; via: string } | { ok: false; reason: string };
export interface DbPlan {
  run: DbGate[];
  notRun: { name: string; reason: string }[];
  skipped: string[];
}

export declare const DB_ENV_VARS: readonly string[];
export declare const DB_GATES: readonly DbGate[];
export declare const databaseAvailable: (
  env?: Record<string, string | undefined>,
  spawn?: (
    command: string,
    args: string[],
    options: object
  ) => { status: number | null; error?: { code?: string; message?: string } }
) => DbAvailability;
export declare const planDbGates: (options?: {
  noDb?: boolean;
  migrations?: boolean;
  probe?: () => DbAvailability;
}) => DbPlan;
