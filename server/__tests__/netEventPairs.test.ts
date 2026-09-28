// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every raw net event the client sends is one the server listens for, and the reverse
 * (MICA-263).
 *
 * The raw `TriggerServerEvent('mica:server:…')` sends and the raw `onNet` handlers are two
 * literals in two trees, and nothing else ties them together: `routes.test.ts` holds the
 * contracted actions, which ride `ServiceProxy` and a derived name, but a raw event renamed on
 * one side only compiles, passes every other suite, and does nothing in game. MICA-262 renamed
 * the client half of `checkPhoneItem` first and had to leave a comment promising not to, which
 * is the kind of promise this makes a failing test instead.
 *
 * Read from source rather than by importing, like `netGuardCensus.test.ts`, so a handler
 * registered behind a condition still counts. Comment lines are skipped, since the example in
 * `netGuard.ts`'s docblock is not a handler.
 */
const ROOT = join(__dirname, '..', '..');

const walk = (dir: string): string[] => {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line);

/** Every `mica:server:*` literal a call named `callee` takes as its first argument. */
const literalsIn = (dir: string, callee: string): Map<string, string> => {
  const found = new Map<string, string>();
  const call = new RegExp(`\\b${callee}\\(\\s*['"\`](mica:server:[^'"\`]+)['"\`]`, 'g');
  for (const file of walk(join(ROOT, dir))) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !isComment(line))
      .join('\n');
    for (const match of code.matchAll(call)) {
      if (!found.has(match[1])) found.set(match[1], relative(ROOT, file));
    }
  }
  return found;
};

/** Any send that names its event some other way cannot be paired, so it is refused too. */
const unpairableSends = (): string[] => {
  const out: string[] = [];
  for (const file of walk(join(ROOT, 'client'))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (isComment(line) || !/\bTriggerServerEvent\(/.test(line)) return;
        if (/\bTriggerServerEvent\(\s*['"]mica:server:/.test(line)) return;
        out.push(`${relative(ROOT, file)}:${index + 1}`);
      });
  }
  return out;
};

describe('raw net events pair up across client/ and server/ (MICA-263)', () => {
  const sent = literalsIn('client', 'TriggerServerEvent');
  const handled = literalsIn('server', 'onNet');

  it('finds both sides, so the pairing below is not vacuous', () => {
    // Nine raw handlers today (`docs/security.md`'s census); a scan that read none would pass.
    expect(sent.size).toBeGreaterThanOrEqual(9);
    expect(handled.size).toBeGreaterThanOrEqual(9);
  });

  it('sends every raw event by its literal name, where this scan can read it', () => {
    expect(unpairableSends(), 'a templated send cannot be paired with a handler').toEqual([]);
  });

  it('has a server handler for every event the client sends', () => {
    const orphaned = [...sent]
      .filter(([event]) => !handled.has(event))
      .map(([event, file]) => `${event} (sent from ${file})`);
    expect(orphaned, 'renamed on one side only? It does nothing in game').toEqual([]);
  });

  it('has a client sender for every raw handler the server registers', () => {
    const unreached = [...handled]
      .filter(([event]) => !sent.has(event))
      .map(([event, file]) => `${event} (handled in ${file})`);
    expect(unreached, 'a handler nothing sends is attack surface with no feature').toEqual([]);
  });
});
