// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseRequestEvent, requestEventFor, responseEventFor } from '@mica/shared/rpc';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

// Loading the controllers is what populates the service registry — it is filled as a side
// effect of constructing each endpoint, not by importing the module that holds it.
import '../services';
import { knownServices } from '../lib/services';
import { QB_PHONE_ANSWERED } from '@mica/shared/qbPhoneEvents';

/**
 * Every `mica:` event name in the source has to match `mica:<side>:<app>:<action>`.
 *
 * This is the point of the exercise. Renaming the fifteen offenders is a one-time fix;
 * this test is what stops the sixteenth. Names drifted in the first place because
 * nothing checked them — `mica:call:failed` had no side segment at all, so you could
 * not tell from the name whether it was emitted by the client or the server.
 *
 * Scans source text rather than a registry because that is where the risk lives: a
 * hand-written `onNet('mica:server:doThing')` never passes through `requestEventFor`
 * and so no amount of runtime validation would see it.
 *
 * `web/src` is scanned too, even though NUI message actions are a separate namespace
 * from net events and are not prefixed. That is the point: a `mica:`-prefixed string
 * over there is either a net event in the wrong place or an action name borrowing a
 * prefix it has no business with. Both are worth a failure.
 */

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['client', 'server', 'shared', 'web/src'];
// `__tests__` is excluded on purpose: those files carry deliberately malformed names to
// prove the parser rejects them, and a scanner that flagged them would push the fixtures
// toward being valid — which is exactly the bug it is meant to catch.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.svelte-kit', '__tests__']);
const EXTENSIONS = ['.ts', '.svelte', '.js'];

/**
 * Names allowed to sit outside the convention.
 *
 * Deliberately empty. An entry here is a promise that the name is load-bearing
 * somewhere the convention cannot reach — a third-party resource's event, say — not a
 * place to park something awkward.
 */
const EXEMPT = new Set<string>([]);

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
};

interface Found {
  event: string;
  file: string;
}

const collect = (): Found[] => {
  const found: Found[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8');
      // Only string literals. A template like `mica:server:${app}:get` is the
      // convention being applied, not violated.
      for (const match of text.matchAll(/['"`](mica:[a-zA-Z0-9_:]+)['"`]/g)) {
        found.push({ event: match[1], file: relative(ROOT, file) });
      }
    }
  }
  return found;
};

const ALL = collect();

/**
 * Names under another phone's prefix (MICA-222). micaOS answers a handful of qb-phone's
 * events so qb scripts work unmodified, and every one of them is declared in
 * `shared/qbPhoneEvents.ts` -- the list the start-up line prints and the README repeats.
 * A foreign-prefixed literal anywhere else is a name nobody wrote down.
 */
const FOREIGN_PREFIXES = ['qb-phone', 'lb-phone', 'npwd', 'gksphone', 'qs-smartphone'];

const collectForeign = (): Found[] => {
  const found: Found[] = [];
  const pattern = new RegExp(
    `['"\`]((?:${FOREIGN_PREFIXES.join('|')}):[A-Za-z0-9_:-]+)['"\`]`,
    'g'
  );
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        found.push({ event: match[1], file: relative(ROOT, file) });
      }
    }
  }
  return found;
};

describe('net event naming', () => {
  it('finds event names to check at all', () => {
    // Guards the regex and the walk: a scanner that silently matches nothing would let
    // every other assertion here pass vacuously.
    expect(ALL.length).toBeGreaterThan(20);
  });

  it('every name is mica:<side>:<app>:<action>', () => {
    const offenders = ALL.filter(({ event }) => {
      if (EXEMPT.has(event)) return false;
      const parts = event.split(':');
      if (parts.length !== 4) return true;
      const [, side, app, action] = parts;
      if (side !== 'server' && side !== 'client') return true;
      return app.length === 0 || action.length === 0;
    });

    expect(
      offenders.map(({ event, file }) => `${event}  (${file})`).toSorted(),
      'add the missing segment rather than exempting the name'
    ).toEqual([]);
  });

  it('server request names round-trip through requestEventFor', () => {
    const requests = ALL.filter(({ event }) => event.startsWith('mica:server:'));
    expect(requests.length).toBeGreaterThan(0);

    for (const { event, file } of requests) {
      const parsed = parseRequestEvent(event);
      expect(parsed, `${event} in ${file} is not parseable`).not.toBeNull();
      expect(requestEventFor(parsed!.service, parsed!.action), `${event} in ${file}`).toBe(event);
    }
  });

  it('the service segment names a real service', () => {
    // Catches a typo'd or invented segment — `mica:client:setting:x` would otherwise
    // satisfy the shape check and then match no listener.
    //
    // Reads the registry rather than a list kept here. This test used to carry
    // `NON_APP_SEGMENTS = ['shell', 'admin']` and a second exception for `bank` and
    // `phone`, because the vocabulary called every segment an "app" and four of them
    // were not. Services declare themselves now, so there is nothing left to exempt.
    const known = new Set<string>(knownServices());
    expect(known.size, 'services did not load').toBeGreaterThan(0);

    const unknown = ALL.filter(({ event }) => {
      if (EXEMPT.has(event)) return false;
      const parts = event.split(':');
      return parts.length === 4 && !known.has(parts[2]);
    });

    expect(unknown.map(({ event, file }) => `${event}  (${file})`).toSorted()).toEqual([]);
  });
});

describe('response event derivation', () => {
  it('maps the four CRUD actions to their reply names', () => {
    expect(responseEventFor('notes', 'get')).toBe('mica:client:notes:receive');
    expect(responseEventFor('notes', 'create')).toBe('mica:client:notes:created');
    expect(responseEventFor('notes', 'update')).toBe('mica:client:notes:updated');
    expect(responseEventFor('notes', 'delete')).toBe('mica:client:notes:deleted');
  });

  it('passes a custom action through unchanged', () => {
    expect(responseEventFor('mail', 'markAsRead')).toBe('mica:client:mail:markAsRead');
  });
});

describe("another phone's event names", () => {
  const foreign = collectForeign();

  it('finds the qb-phone names micaOS answers, so the check is not vacuous', () => {
    expect(foreign.length).toBeGreaterThan(0);
  });

  it('every foreign-prefixed name is one shared/qbPhoneEvents.ts declares', () => {
    const declared = new Set<string>(QB_PHONE_ANSWERED);
    const undeclared = foreign.filter(({ event }) => !declared.has(event));
    expect(
      undeclared.map(({ event, file }) => `${event}  (${file})`).toSorted(),
      'declare it in shared/qbPhoneEvents.ts, where the start-up line and the README read it'
    ).toEqual([]);
  });

  it('every declared name is registered somewhere, or the README promises a listener that does not exist', () => {
    // The declaration itself does not count as a listener.
    const seen = new Set(
      foreign.filter(({ file }) => !file.startsWith('shared/')).map(({ event }) => event)
    );
    expect(QB_PHONE_ANSWERED.filter((event) => !seen.has(event))).toEqual([]);
  });
});
