// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { unique } from '../lib/mica';
import { eventually } from '../lib/wait';

/**
 * The premise every command scenario stands on (MICA-302): a command this resource runs with
 * `ExecuteCommand` reaches its handler with `source` 0, the console's — the only source
 * `micaschema apply`, `micacrypt`, `micaimport` and `micamedia prune` accept (each refuses any
 * other with a toast and nothing in the console).
 *
 * Proven here on a command of this resource's own, so a failure says "the premise is wrong"
 * rather than "some command misbehaved". The command scenarios then prove it again for micaOS's
 * own: each asserts a write only a source-0 run makes.
 */
export const commandScenarios: Scenario[] = [
  {
    id: 'commands-execute-command-arrives-as-console-source-0',
    tickets: ['MICA-302'],
    timeoutMs: 10_000,
    run: async (signal) => {
      const name = unique('probe').replace(/[^a-z0-9_]/g, '_');
      let seen: unknown[] | null = null;
      RegisterCommand(
        name,
        (source: unknown, args: unknown) => {
          seen = [source, args];
        },
        false
      );
      ExecuteCommand(`${name} one two`);
      const [source, args] = await eventually(async () => seen, 5_000, signal, 'the probe run');
      if (source !== 0) {
        throw new Error(`the probe ran with source ${JSON.stringify(source)}, not 0`);
      }
      if (JSON.stringify(args) !== JSON.stringify(['one', 'two'])) {
        throw new Error(`the probe got args ${JSON.stringify(args)}`);
      }
    }
  }
];
