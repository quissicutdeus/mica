import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROUTES, CLIENT_ONLY_ACTIONS, UNIMPLEMENTED_ACTIONS, serverEventFor } from '@shared/routes';

/**
 * The NUI round trip has three layers — `web/` calls, `client/` relays, `server/`
 * handles — and a gap in any one of them fails **silently**. `fetchNui` swallows an
 * unregistered callback and returns its default, so the feature does nothing in game
 * and throws nothing anywhere.
 *
 * The browser mock registry makes it worse: it answers by action name, so a feature
 * with no client or server wiring works perfectly in `pnpm dev` and in Playwright.
 * Every silent no-op this codebase has shipped — `readConversation`,
 * `renameConversation`, `archiveConversation`, `rejectCall`, `flipCamera`, all four
 * mail actions — passed every test that existed at the time.
 *
 * These assertions are the layer that would have caught them.
 */

const { dbMock, registeredServerEvents } = vi.hoisted(() => {
  /**
   * Capture what the server registers.
   *
   * Installed inside `vi.hoisted` because ESM evaluates every `import` before any
   * module-level statement — a plain assignment here would run *after*
   * `import '../services'` and record nothing, which is exactly the vacuous-pass
   * failure mode this file warns about elsewhere.
   */
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

const ROOT = join(__dirname, '..', '..');

const walk = (dir: string, exts: string[]): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
};

/** Every `fetchNui('name', ...)` call site in `web/src`. */
const collectFetchNuiCalls = (): { action: string; file: string }[] => {
  const found: { action: string; file: string }[] = [];
  for (const file of walk(join(ROOT, 'web', 'src'), ['.ts', '.svelte'])) {
    // Mocks and tests describe the surface rather than consume it.
    if (file.includes('/mocks/') || file.endsWith('.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    /**
     * The generic is optional and may itself contain generics, to any depth.
     *
     * `<[^>]*>` stopped at the first `>`, which for `fetchNui<Record<number, Engagement>>(...)`
     * lands inside the `Record` — so the call did not match, the action looked uncalled, and
     * this test reported a live route as dead weight. The fix for that counted exactly one
     * level of nesting and said one was enough for every shape in this codebase. That expired:
     * `fetchNui<Partial<Record<AppCapability, boolean>>>('checkCapabilities')` is two, and the
     * scanner reported the freshly-wired capabilities route as dead weight (MICA-151).
     *
     * Counting levels is the wrong shape of fix — each new depth is a silent blind spot until
     * somebody writes that depth and gets a false alarm. So the generic is matched lazily and
     * anchored on the `(` that must follow it. Depth stops mattering: the match ends at
     * whichever `>` precedes the call's own paren.
     *
     * The character class is what keeps that honest. A bare `[\s\S]*?` backtracks across
     * newlines and a function body, so `fetchNui<T = unknown>(` — the *declaration* in
     * `sdk/host/iframe/fetchNui.ts` — ran on until it found `remoteCall<T>('service')` and
     * reported `service` as an action `web/` calls. Barring `(`, `)` and a newline inside the
     * generic confines a match to one call site on one line, which is every real one here.
     *
     * It stays a scanner rather than a parser, and it fails closed in both directions: a call
     * site it cannot read reports a live route as dead weight, never a dead route as live. A
     * generic broken across lines would be the former — loud, and fixed by reading this note.
     */
    for (const m of text.matchAll(/fetchNui\s*(?:<[^()\n]*?>)?\s*\(\s*['"]([a-zA-Z][\w]*)['"]/g)) {
      found.push({ action: m[1], file: relative(ROOT, file) });
    }
  }
  return found;
};

/**
 * Action names declared rather than called — `createCrudStore('Notes', { list: 'getNotes' })`.
 *
 * A store built from a declaration contains no `fetchNui('getNotes')` for the scanner
 * above to find, so without this every CRUD route read as uncalled and the dead-weight
 * check told us to delete thirteen live routes. The scan has to follow the code, not the
 * other way round.
 */
const collectCrudStoreEvents = (): { action: string; file: string }[] => {
  const found: { action: string; file: string }[] = [];
  /**
   * All of `web/src`, not just `services/`.
   *
   * An add-on owns its store inside its own directory — `apps/notes/store.ts`,
   * `apps/blabber/store.ts` — because core's services directory is not somewhere an app
   * installed from the Store can add to. Scanning only `services/` made those stores
   * invisible, and the dead-weight check then reported live routes as unused.
   */
  for (const file of walk(join(ROOT, 'web', 'src'), ['.ts'])) {
    if (file.endsWith('.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const call of text.matchAll(/createCrudStore\s*(?:<[\s\S]*?>)?\s*\(/g)) {
      // The config object is the last argument; a window is enough and keeps this a
      // scanner rather than a parser.
      const window = text.slice(call.index!, call.index! + 600);
      // Same reason as the paged case above: `service:` means the generic route.
      if (/\bservice\s*:/.test(window)) continue;
      for (const m of window.matchAll(/\b(?:list|create|update|remove)\s*:\s*['"](\w+)['"]/g)) {
        found.push({ action: m[1], file: relative(ROOT, file) });
      }
    }

    /**
     * `createPagedStore('getBlabs')` takes its action as the first argument rather than in a
     * config object, so the pattern above cannot see it — and a route it cannot see is reported
     * as dead weight the moment somebody adds a paged feed.
     *
     * Both factories are matched rather than one generic "any call with a string literal",
     * because the point of this scan is to follow the *known* ways an action name reaches
     * `fetchNui`. A pattern loose enough to catch every string would also catch strings that
     * are not actions, and a false pass here is worse than a false failure.
     */
    for (const m of text.matchAll(/createPagedStore\s*(?:<[\s\S]*?>)?\s*\(\s*['"](\w+)['"]/g)) {
      // A store with `service:` set reaches the server through the generic route, so its
      // first argument is a *server* action name rather than a row in this table.
      // Counting it here reports `get` and `following` as NUI routes nobody declared.
      if (/\bservice\s*:/.test(text.slice(m.index!, m.index! + 400))) continue;
      found.push({ action: m[1], file: relative(ROOT, file) });
    }
  }
  return found;
};

/** Action names the client registers by hand, outside the route table. */
const collectClientCallbacks = (): Set<string> => {
  const names = new Set<string>();
  for (const file of walk(join(ROOT, 'client'), ['.ts'])) {
    if (file.includes('__tests__')) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/RegisterNuiCallbackType\(\s*['"]([a-zA-Z][\w]*)['"]\s*\)/g)) {
      names.add(m[1]);
    }
  }
  return names;
};

const mockRegistryKeys = (): Set<string> => {
  const text = readFileSync(join(ROOT, 'web', 'src', 'nui', 'mocks', 'registry.ts'), 'utf8');
  const body = text.slice(text.indexOf('mockRegistry'));
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s{2}([a-zA-Z][\w]*)\s*:/gm)) keys.add(m[1]);
  // The CRUD handlers are spread in from `defineMockCrud(fixtures, { list: 'getMail' })`
  // rather than written as literal keys, so they are named in the call and not in the
  // object. Same reason the fetch scanner has to read `createCrudStore` declarations.
  for (const call of body.matchAll(/defineMockCrud\s*(?:<[\s\S]*?>)?\s*\(/g)) {
    const window = body.slice(call.index!, call.index! + 600);
    for (const m of window.matchAll(/\b(?:list|create|update|remove)\s*:\s*['"](\w+)['"]/g)) {
      keys.add(m[1]);
    }
  }
  return keys;
};

const FETCH_CALLS = [...collectFetchNuiCalls(), ...collectCrudStoreEvents()];
const CRUD_EVENTS = collectCrudStoreEvents();
const CLIENT_CALLBACKS = collectClientCallbacks();
const MOCKS = mockRegistryKeys();
const ROUTE_ACTIONS = new Set(ROUTES.map((r) => r.action));
const HANDLED = new Set<string>([
  ...ROUTE_ACTIONS,
  ...CLIENT_ONLY_ACTIONS,
  ...UNIMPLEMENTED_ACTIONS
]);

describe('route table', () => {
  it('scans a plausible amount of source', () => {
    // A scanner that silently matched nothing would make every assertion below vacuous.
    expect(registeredServerEvents.size).toBeGreaterThan(10);
    expect(FETCH_CALLS.length).toBeGreaterThan(20);
    expect(CLIENT_CALLBACKS.size).toBeGreaterThan(5);
    expect(MOCKS.size).toBeGreaterThan(20);
    // The declarative half specifically. If `createCrudStore` were renamed and this
    // collector quietly stopped matching, the dead-weight check would start failing for
    // reasons that have nothing to do with dead weight. The floor tracks the real count,
    // which moves down as well as up: Blabber's `followers`/`following` stores now read
    // through the `accounts` facet (MICA-16 step 4 — an add-on cannot name a NUI route
    // from inside the sandbox), so they declare no action name for this collector to find.
    // It moved down again for MICA-110: `gphone_media` declares `paging`, which changes
    // the generic `get` reply from a bare array to `{ rows, nextCursor }`, so the gallery
    // is a `createPagedStore` now and its three CRUD names are no longer declared in the
    // shape this collector reads. They are still routed, still called, and still checked —
    // by `collectFetchNuiCalls` and the paged-store scanner below.
    expect(CRUD_EVENTS.length).toBeGreaterThan(7);
  });

  it('declares no duplicate NUI action names', () => {
    // A duplicate would mean the second `RegisterNuiCallbackType` quietly wins.
    const seen = new Set<string>();
    const dupes = ROUTES.filter((r) => (seen.has(r.action) ? true : (seen.add(r.action), false)));
    expect(dupes.map((r) => r.action)).toEqual([]);
  });

  it('never lists an action as both routed and client-only', () => {
    const overlap = [...CLIENT_ONLY_ACTIONS, ...UNIMPLEMENTED_ACTIONS].filter((a) =>
      ROUTE_ACTIONS.has(a)
    );
    expect(overlap).toEqual([]);
  });
});

describe('no missing layer', () => {
  it('every action web/ calls is handled somewhere', () => {
    const orphans = FETCH_CALLS.filter(({ action }) => !HANDLED.has(action));
    expect(
      [...new Set(orphans.map(({ action, file }) => `${action}  (${file})`))].toSorted(),
      'web calls this and nothing answers it in game — the mock registry hides that'
    ).toEqual([]);
  });

  it('every route reaches a server event that is actually registered', () => {
    const missing = ROUTES.filter((r) => !registeredServerEvents.has(serverEventFor(r)));
    expect(
      missing.map((r) => `${r.action} -> ${serverEventFor(r)}`).toSorted(),
      'the client would forward this and the server would never answer, so the NUI ' +
        'callback hangs for 15s and then reports a timeout'
    ).toEqual([]);
  });

  it('every client-only action really is registered on the client', () => {
    const missing = CLIENT_ONLY_ACTIONS.filter((a) => !CLIENT_CALLBACKS.has(a));
    expect(missing.toSorted()).toEqual([]);
  });

  it('every unimplemented action still answers, rather than doing nothing', () => {
    // The promise of the unimplemented list is that the web is told, not that the
    // callback is absent. An absent one is exactly the silent no-op being outlawed.
    const missing = UNIMPLEMENTED_ACTIONS.filter((a) => !CLIENT_CALLBACKS.has(a));
    expect(missing.toSorted()).toEqual([]);
  });
});

describe('no dead weight', () => {
  it('every declared route is actually called by web/', () => {
    const called = new Set(FETCH_CALLS.map((c) => c.action));
    const unused = [...ROUTE_ACTIONS].filter((a) => !called.has(a));
    expect(unused.toSorted(), 'delete the route, or wire up the caller').toEqual([]);
  });

  it('every route and client-only action has a browser mock', () => {
    // Without a mock the feature is broken in `pnpm dev` and in Playwright while
    // working in game — the same class of bug, pointing the other way.
    const missing = [...ROUTE_ACTIONS, ...CLIENT_ONLY_ACTIONS, ...UNIMPLEMENTED_ACTIONS].filter(
      (a) => !MOCKS.has(a)
    );
    expect(missing.toSorted()).toEqual([]);
  });
});
