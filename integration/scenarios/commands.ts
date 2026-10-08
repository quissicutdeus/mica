// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { unique } from '../lib/mica';
import { eventually } from '../lib/wait';

/**
 * The premise every command scenario stands on (MICA-302): a command this resource runs with
 * `ExecuteCommand` reaches its handler with `source` 0, the console's — the only source
 * `micaschema apply`, `micacrypt`, `micaimport`, `micahttp` and `micamedia prune` accept (each
 * refuses any other with a toast and nothing in the console).
 *
 * Proven here on a command of this resource's own, so a failure says "the premise is wrong"
 * rather than "some command misbehaved". The command scenarios then prove it again for micaOS's
 * own: each asserts a write only a source-0 run makes.
 */
export const commandScenarios: Scenario[] = [
  {
    id: 'commands-execute-command-arrives-as-console-source-0',
    mode: 'standalone',
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
  },
  {
    /**
     * Every console command micaOS documents is registered by the `mica` resource
     * (docs/in-game-commands.md; MICA-274 renamed the first five). Read from FXServer's own
     * command table, so a command lost in a rename, or registered under the old prefix, fails
     * here rather than surfacing as "unknown command" on somebody's server.
     */
    id: 'commands-every-documented-command-is-registered-by-mica',
    mode: 'standalone',
    tickets: ['MICA-274'],
    timeoutMs: 10_000,
    run: async () => {
      const expected = [
        'micaschema',
        'micamedia',
        'micacharge',
        'micacall',
        'micaseed',
        'micaimport',
        'micacrypt',
        'micahttp'
      ];
      const table = GetRegisteredCommands() as { name?: unknown; resource?: unknown }[];
      if (!Array.isArray(table) || table.length === 0) {
        throw new Error('GetRegisteredCommands returned no command table');
      }
      const ours = new Map<string, unknown>();
      for (const row of table) {
        if (typeof row?.name === 'string') ours.set(row.name.toLowerCase(), row.resource);
      }
      const missing = expected.filter((name) => !ours.has(name));
      if (missing.length > 0) throw new Error(`not registered: ${missing.join(', ')}`);
      const elsewhere = expected.filter((name) => ours.get(name) !== 'mica');
      if (elsewhere.length > 0) {
        throw new Error(
          `registered, but not by mica: ${elsewhere.map((n) => `${n} (${String(ours.get(n))})`).join(', ')}`
        );
      }
      // Everything mica registers carries its prefix, so a command left under a pre-rename
      // name fails here without this file having to spell any old name out.
      const unprefixed = [...ours.entries()]
        .filter(([name, resource]) => resource === 'mica' && !name.startsWith('mica'))
        .map(([name]) => name);
      if (unprefixed.length > 0) {
        throw new Error(`mica registers commands without its prefix: ${unprefixed.join(', ')}`);
      }
    }
  }
];
