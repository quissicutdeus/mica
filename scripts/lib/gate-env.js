// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The environment `pnpm verify` hands to every gate.
 *
 * Tools that print or behave differently when an AI agent is driving them decide that
 * from the environment: svelte-check picks its output format (`machine` under
 * `CLAUDECODE=1`, `human-verbose` everywhere else, CI included), and `std-env` -- under
 * Vitest, and through `jiti` under Vite's toolchain -- reads both `CLAUDECODE` and
 * `CLAUDE_CODE`. Every Claude Code shell sets them, so a `pnpm verify` run by an agent was
 * not the run CI does, and `ac815c3d` passed here on an assertion about the machine format
 * that CI's output could never satisfy.
 *
 * Exactly these two names and nothing else. `CLAUDE_CODE_*` is a family of unrelated
 * variables (session id, entrypoint, the messaging socket) and none of them is a detector.
 *
 * Kept out of `scripts/verify.js` because that file runs the gates on import, which leaves
 * a unit test nothing to call.
 */
export const AGENT_ENV_VARS = ['CLAUDECODE', 'CLAUDE_CODE'];

/**
 * `env` without the agent markers, and the names that were actually present in it.
 *
 * A pure function of its argument: it never reads or writes `process.env`, so the caller
 * decides where the result goes. A variable that is set but empty counts as present -- it
 * is removed either way, and a notice for it is cheaper than a debugging session.
 */
export const gateEnv = (env) => {
  const removed = AGENT_ENV_VARS.filter((name) => Object.hasOwn(env, name));
  const clean = { ...env };
  for (const name of removed) delete clean[name];
  return { env: clean, removed };
};

/** The one line `verify` prints when it removed something, or null when it removed nothing. */
export const gateEnvNotice = (removed) =>
  removed.length === 0
    ? null
    : `verify: removed ${removed.join(', ')} from the gates' environment, so the gates see what CI sees.`;
