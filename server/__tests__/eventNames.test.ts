import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseRequestEvent, requestEventFor, responseEventFor } from '@shared/rpc';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

// Loading the controllers is what populates the service registry — it is filled as a side
// effect of constructing each endpoint, not by importing the module that holds it.
import '../services';
import { knownServices } from '../lib/services';

/**
 * Every `gphone:` event name in the source has to match `gphone:<side>:<app>:<action>`.
 *
 * This is the point of the exercise. Renaming the fifteen offenders is a one-time fix;
 * this test is what stops the sixteenth. Names drifted in the first place because
 * nothing checked them — `gphone:call:failed` had no side segment at all, so you could
 * not tell from the name whether it was emitted by the client or the server.
 *
 * Scans source text rather than a registry because that is where the risk lives: a
 * hand-written `onNet('gphone:server:doThing')` never passes through `requestEventFor`
 * and so no amount of runtime validation would see it.
 *
 * `web/src` is scanned too, even though NUI message actions are a separate namespace
 * from net events and are not prefixed. That is the point: a `gphone:`-prefixed string
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
      // Only string literals. A template like `gphone:server:${app}:get` is the
      // convention being applied, not violated.
      for (const match of text.matchAll(/['"`](gphone:[a-zA-Z0-9_:]+)['"`]/g)) {
        found.push({ event: match[1], file: relative(ROOT, file) });
      }
    }
  }
  return found;
};

const ALL = collect();

describe('net event naming', () => {
  it('finds event names to check at all', () => {
    // Guards the regex and the walk: a scanner that silently matches nothing would let
    // every other assertion here pass vacuously.
    expect(ALL.length).toBeGreaterThan(20);
  });

  it('every name is gphone:<side>:<app>:<action>', () => {
    const offenders = ALL.filter(({ event }) => {
      if (EXEMPT.has(event)) return false;
      const parts = event.split(':');
      if (parts.length !== 4) return true;
      const [, side, app, action] = parts;
      if (side !== 'server' && side !== 'client') return true;
      return app.length === 0 || action.length === 0;
    });

    expect(
      offenders.map(({ event, file }) => `${event}  (${file})`).sort(),
      'add the missing segment rather than exempting the name'
    ).toEqual([]);
  });

  it('server request names round-trip through requestEventFor', () => {
    const requests = ALL.filter(({ event }) => event.startsWith('gphone:server:'));
    expect(requests.length).toBeGreaterThan(0);

    for (const { event, file } of requests) {
      const parsed = parseRequestEvent(event);
      expect(parsed, `${event} in ${file} is not parseable`).not.toBeNull();
      expect(requestEventFor(parsed!.service, parsed!.action), `${event} in ${file}`).toBe(event);
    }
  });

  it('the service segment names a real service', () => {
    // Catches a typo'd or invented segment — `gphone:client:setting:x` would otherwise
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

    expect(unknown.map(({ event, file }) => `${event}  (${file})`).sort()).toEqual([]);
  });
});

describe('response event derivation', () => {
  it('maps the four CRUD actions to their reply names', () => {
    expect(responseEventFor('notes', 'get')).toBe('gphone:client:notes:receive');
    expect(responseEventFor('notes', 'create')).toBe('gphone:client:notes:created');
    expect(responseEventFor('notes', 'update')).toBe('gphone:client:notes:updated');
    expect(responseEventFor('notes', 'delete')).toBe('gphone:client:notes:deleted');
  });

  it('passes a custom action through unchanged', () => {
    expect(responseEventFor('mail', 'markAsRead')).toBe('gphone:client:mail:markAsRead');
  });
});
