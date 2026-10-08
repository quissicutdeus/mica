// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `gate-env.js`, a plain JS build module. */

export declare const AGENT_ENV_VARS: readonly string[];
export declare const gateEnv: <E extends Record<string, string | undefined>>(
  env: E
) => { env: E; removed: string[] };
export declare const gateEnvNotice: (removed: string[]) => string | null;
