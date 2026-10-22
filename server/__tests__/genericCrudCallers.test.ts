// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROUTES } from '@mica/shared/routes';
import { stripComments } from '../../scripts/lib/localeUsage.js';

/**
 * Every generic CRUD event a service registers has a caller (MICA-414).
 *
 * `defineService` registers `get`, `create`, `update` and `delete` for a table unless the
 * declaration turns one off, so the default is four reachable net events per table whether or
 * not the phone ever sends them. A registered event is reachable regardless (§2.9), so an
 * uncalled one is attack surface with no feature behind it. `mica:server:blocklist:*` were three
 * of those: the table and `isBlocked` are real, but nothing in `web/` or `sdk/` ever listed,
 * added or removed a blocked number.
 *
 * `reachability.test.ts` pins a hand-picked list of events that must stay off. This is the
 * general rule it was standing in for: a generic event is registered only if `web/src` or `sdk`
 * reaches it, through one of the ways those reach the generic CRUD:
 *
 * - a row in `shared/routes.ts`, which `routes.test.ts` already holds to a real caller;
 * - `createCrudStore(…, { service: '<id>' })`, whose events are then server action names;
 * - `createPagedStore('<action>', { service: '<id>' })`, likewise;
 * - `useService('<id>').call('<action>', …)`, inline or through a local `() => useService(…)`.
 *
 * It is a scanner, and it fails closed in the direction that matters: a call site it cannot
 * read reports a live event as uncalled — loud, and fixed by teaching the scan the new shape —
 * never an uncalled one as live.
 */

const { dbMock, registeredServerEvents } = vi.hoisted(() => {
  // Inside `vi.hoisted` so it is installed before `import '../services'` registers anything.
  const events = new Set<string>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: unknown) => {
    events.add(event);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    registeredServerEvents: events
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import '../services';
import { registeredCustomActions } from '../lib/services';

const ROOT = join(__dirname, '..', '..');
const GENERIC = ['get', 'create', 'update', 'delete'] as const;

/**
 * Generic events that stay registered with no caller in `web/src` or `sdk`, each with why.
 *
 * Empty is the goal. An entry is a decision that an event with nothing calling it is still worth
 * being reachable — the bar is a caller outside this repo, not "it might be useful".
 */
const UNCALLED_BUT_KEPT: Readonly<Record<string, string>> = {};

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

/** `web/src` and `sdk`, minus tests and the browser mocks — those describe the surface. */
const sources = (): { file: string; text: string }[] =>
  [...walk(join(ROOT, 'web', 'src')), ...walk(join(ROOT, 'sdk'))]
    .filter((file) => !file.includes('/mocks/'))
    .map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, 'utf8') }));

/**
 * The text of a call's argument list, from the `(` at `open` to its matching `)`, or `''` when
 * it never closes.
 *
 * What bounds a `createCrudStore` or `createPagedStore` to its own call. A fixed window of
 * characters ran on into the next call, so a neighbour's `remove: 'delete'` was credited to the
 * first store's service. Quoted strings are skipped so a paren inside one does not count; an
 * unbalanced call reads as no call, which reports a live event as uncalled rather than the
 * reverse.
 */
const argumentsAt = (text: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const close = text.indexOf(ch, i + 1);
      if (close < 0) return '';
      i = close;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return '';
};

/** `service:action` for every generic CRUD call the scan can see, with where it saw it. */
const collectGenericCallers = (
  files: readonly { file: string; text: string }[] = sources(),
  routes: readonly { service: string; serverAction: string }[] = ROUTES
): Map<string, string> => {
  const found = new Map<string, string>();
  const add = (service: string, action: string, where: string) => {
    if (!found.has(`${service}:${action}`)) found.set(`${service}:${action}`, where);
  };

  for (const r of routes) add(r.service, r.serverAction, 'shared/routes.ts');

  for (const { file, text: raw } of files) {
    // A call in a comment is an example, not a caller: `sdk/lib/errors.ts`'s JSDoc shows one.
    const text = stripComments(raw);
    // The generic may not contain a paren, for the reason `routes.test.ts` gives: a lazy match
    // through one runs on into the next call. Newlines stay allowed — `contacts.ts` breaks one.
    for (const m of text.matchAll(/\bcreateCrudStore\s*(?:<[^()]*?>)?\s*\(/g)) {
      const window = argumentsAt(text, m.index + m[0].length - 1);
      const service = /\bservice\s*:\s*['"](\w+)['"]/.exec(window)?.[1];
      if (!service) continue; // named NUI actions — a ROUTES row, counted above
      for (const e of window.matchAll(/\b(?:list|create|update|remove)\s*:\s*['"](\w+)['"]/g)) {
        add(service, e[1]!, file);
      }
    }

    for (const m of text.matchAll(/\bcreatePagedStore\s*(?:<[^()]*?>)?\s*(\()\s*['"](\w+)['"]/g)) {
      const open = m.index + m[0].lastIndexOf('(');
      const service = /\bservice\s*:\s*['"](\w+)['"]/.exec(argumentsAt(text, open))?.[1];
      if (service) add(service, m[2]!, file);
    }

    // `const blabberService = () => useService('blabber')`, then `blabberService().call('create'`.
    const bound = new Map<string, string>();
    for (const m of text.matchAll(
      /\bconst\s+(\w+)\s*=\s*\(\)\s*=>\s*useService\(\s*['"](\w+)['"]\s*\)/g
    )) {
      bound.set(m[1]!, m[2]!);
    }
    const CALL = String.raw`\s*\.call\s*(?:<[^()]*?>)?\s*\(\s*['"](\w+)['"]`;
    for (const m of text.matchAll(
      new RegExp(String.raw`\buseService\(\s*['"](\w+)['"]\s*\)` + CALL, 'g')
    )) {
      add(m[1]!, m[2]!, file);
    }
    for (const m of text.matchAll(new RegExp(String.raw`\b(\w+)\(\)` + CALL, 'g'))) {
      const service = bound.get(m[1]!);
      if (service) add(service, m[2]!, file);
    }
  }
  return found;
};

/** `service:action` for every generic CRUD event registered — custom actions of the same name excluded. */
const registeredGeneric = (): string[] => {
  const custom = new Set(registeredCustomActions());
  const out: string[] = [];
  for (const event of registeredServerEvents) {
    const m = /^mica:server:([a-z][a-z0-9_]*):(\w+)$/.exec(event);
    if (!m || !(GENERIC as readonly string[]).includes(m[2]!)) continue;
    const key = `${m[1]}:${m[2]}`;
    if (!custom.has(key)) out.push(key);
  }
  return out.toSorted();
};

const CALLERS = collectGenericCallers();
const REGISTERED = registeredGeneric();

describe('every generic CRUD event has a caller (MICA-414)', () => {
  it('sees enough of both sides that the check is not vacuous', () => {
    // Notes, Places, Contacts and Media alone are a dozen; the scan reaching none of them would
    // mean it read nothing, and every assertion below would pass on an empty set.
    expect(REGISTERED.length).toBeGreaterThan(15);
    for (const known of ['notes:get', 'places:delete', 'contacts:create', 'blabber:create']) {
      expect(CALLERS.has(known), known).toBe(true);
    }
  });

  it('registers no generic event that nothing in web/src or sdk calls', () => {
    const uncalled = REGISTERED.filter((key) => !CALLERS.has(key) && !(key in UNCALLED_BUT_KEPT));
    expect(uncalled.map((key) => `mica:server:${key}`)).toEqual([]);
  });

  it('keeps no allowlist entry the rule no longer needs', () => {
    // An entry whose event is gone, or has since gained a caller, is a stale reason that reads as
    // a live one.
    const stale = Object.keys(UNCALLED_BUT_KEPT).filter(
      (key) => !REGISTERED.includes(key) || CALLERS.has(key)
    );
    expect(stale).toEqual([]);
  });
});

/**
 * The scanner's own blind spots, on fixtures: each of these once credited a caller that does not
 * exist, which is the direction this file cannot afford — an uncalled event passing as called.
 */
describe('the caller scan', () => {
  const scan = (text: string) => collectGenericCallers([{ file: 'fixture.ts', text }], []);

  it('counts no call that only appears in a comment', () => {
    // `sdk/lib/errors.ts`'s JSDoc shows `useService('journal').call('create', …)` as an example.
    const found = scan(`
      /**
       * await useService('ghost').call('create', { title });
       */
      // useService('ghost').call('delete', { id });
      /* createCrudStore('Ghost', { list: 'get' }, { service: 'ghost' }) */
      export const live = () => useService('real').call('get', {});
    `);
    expect([...found.keys()].toSorted()).toEqual(['real:get']);
  });

  it("credits a store's events to its own service, never a neighbour's", () => {
    // A window of characters ran on past the first call's closing paren into the second's.
    const found = scan(`
      const a = createCrudStore('A', { list: 'get' }, { service: 'alpha' });
      const b = createCrudStore('B', { list: 'get', remove: 'delete' }, { service: 'beta' });
      const c = createCrudStore('C', { list: 'getC', remove: 'deleteC' });
      const d = createPagedStore('feed', {}); const e = createPagedStore('x', { service: 'eps' });
    `);
    expect([...found.keys()].toSorted()).toEqual(['alpha:get', 'beta:delete', 'beta:get', 'eps:x']);
  });
});
