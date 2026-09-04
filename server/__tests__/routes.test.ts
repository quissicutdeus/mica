// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ROUTES,
  CLIENT_ONLY_ACTIONS,
  UNIMPLEMENTED_ACTIONS,
  serverEventFor
} from '@mica/shared/routes';
import { requestEventFor } from '@mica/shared/rpc';
import { allContracts } from '@mica/shared/contract';

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
    for (const call of text.matchAll(/createCrudStore\s*(?:<[^()]*?>)?\s*\(/g)) {
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
     *
     * The generic may not contain a paren, for the reason the `fetchNui` scanner gives
     * above. `[\s\S]*?` let `createPagedStore<UIConversation>(readConversationPage, {` run
     * on for twenty lines until it found `byNewest<UIConversation>('lastMessageAt')`, and
     * reported a sort key as an action nothing answers (MICA-204). Newlines stay allowed,
     * unlike there: `contacts.ts` breaks its `createCrudStore` generic across four lines.
     */
    for (const m of text.matchAll(/createPagedStore\s*(?:<[^()]*?>)?\s*\(\s*['"](\w+)['"]/g)) {
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

/**
 * The `mockRegistry` object literal in `web/src/nui/mocks/registry.ts`, and nothing else.
 *
 * Bounded at both ends, deliberately (MICA-195). This used to slice from the first
 * occurrence of the word `mockRegistry` to the end of the file, which starts in a doc
 * comment forty lines early and runs on through `export const MockRegistry = { has, handle }`
 * — so `has` and `handle` scanned as mock keys. Harmless while the only question asked was
 * "does every route have a mock"; the reverse question below would have reported both as
 * mocks answering nothing.
 */
const mockRegistrySource = (): string => {
  const text = readFileSync(join(ROOT, 'web', 'src', 'nui', 'mocks', 'registry.ts'), 'utf8');
  const start = text.search(/^const mockRegistry\b[^\n]*=\s*\{$/m);
  const end = start === -1 ? -1 : text.indexOf('\n};', start);
  if (start === -1 || end === -1) {
    throw new Error('mocks/registry.ts no longer declares `const mockRegistry ... = {` … `};`');
  }
  return text.slice(start, end);
};

/**
 * Every action the browser mock answers, split by how it is reached.
 *
 * `named` is a bare key — `getNotes: ...` — answered when `fetchNui('getNotes')` is called
 * with that exact name, so it has to be a route or a client-only action to be reachable at
 * all. `scoped` is a `'<service>:<action>'` key, the add-on path: `useService(id).call(...)`
 * arrives as the one generic `svc` action and `resolveGeneric` dispatches it by that pair,
 * so its counterpart is not a route but the server event the pair names.
 */
const mockRegistryKeys = (): { named: Set<string>; scoped: Set<string> } => {
  const body = mockRegistrySource();
  const named = new Set<string>();
  const scoped = new Set<string>();
  // Exactly two spaces of indent is the object's own key, never a nested one.
  for (const m of body.matchAll(/^ {2}(?:([a-zA-Z][\w]*)|'([a-zA-Z][\w]*:[a-zA-Z][\w]*)')\s*:/gm)) {
    if (m[1]) named.add(m[1]);
    else scoped.add(m[2]);
  }
  /**
   * The CRUD handlers are spread in from `defineMockCrud(fixtures, { list: 'getMail' })`
   * rather than written as literal keys, so they are named in the call and not in the
   * object. Same reason the fetch scanner has to read `createCrudStore` declarations.
   *
   * The second argument only. A fixed window after the call used to read the *options*
   * object too, where `remove: 'soft'` says how the server deletes rather than what the
   * action is called — so `soft` scanned as a mock. Harmless while nothing asked whether
   * a mock was reachable; the reverse check below would have reported it as one nothing
   * routes to. The events object holds strings and comments and nothing nested, so a
   * brace-free match is exactly its extent. Notes declares scoped names here
   * (`list: 'notes:get'`), which the old `\w+` could not match at all.
   */
  for (const call of body.matchAll(
    /defineMockCrud\s*(?:<[\s\S]*?>)?\s*\(\s*\w+\s*,\s*(\{[^{}]*\})/g
  )) {
    for (const m of call[1].matchAll(/\b(?:list|create|update|remove)\s*:\s*['"]([\w:]+)['"]/g)) {
      if (m[1].includes(':')) scoped.add(m[1]);
      else named.add(m[1]);
    }
  }
  return { named, scoped };
};

/**
 * Every `call(<x>Contract, 'action', …)` / `callOr(…)` site in `web/src` (MICA-213).
 *
 * A typed call names its service by the contract object rather than by string, so the
 * scanner maps the variable back to the id the way the barrel declares it: every file in
 * `shared/contracts/` exports `const <name> = defineContract({ id: '<id>', … })`, and a
 * name the scanner cannot map is reported rather than skipped — a call site nothing can
 * check is the silent kind this file exists to outlaw.
 */
const contractVariableIds = (): Map<string, string> => {
  const ids = new Map<string, string>();
  for (const file of walk(join(ROOT, 'shared', 'contracts'), ['.ts'])) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /export const (\w+)\s*=\s*defineContract\s*\(\s*\{\s*id:\s*['"]([a-z][a-z0-9_]*)['"]/g
    )) {
      ids.set(m[1], m[2]);
    }
  }
  return ids;
};

const collectTypedCalls = (): { service: string; action: string; file: string }[] => {
  const ids = contractVariableIds();
  const found: { service: string; action: string; file: string }[] = [];
  for (const file of walk(join(ROOT, 'web', 'src'), ['.ts', '.svelte'])) {
    if (file.includes('/mocks/') || file.endsWith('.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bcall(?:Or)?\s*\(\s*(\w+)\s*,\s*['"]([a-zA-Z]\w*)['"]/g)) {
      const service = ids.get(m[1]);
      if (!service) {
        throw new Error(
          `${relative(ROOT, file)} calls '${m[2]}' on '${m[1]}', which is not a contract ` +
            'exported from shared/contracts/ — a typed call has to name one'
        );
      }
      found.push({ service, action: m[2], file: relative(ROOT, file) });
    }
  }
  return found;
};

const FETCH_CALLS = [...collectFetchNuiCalls(), ...collectCrudStoreEvents()];
const TYPED_CALLS = collectTypedCalls();
const CRUD_EVENTS = collectCrudStoreEvents();
const CLIENT_CALLBACKS = collectClientCallbacks();
const { named: MOCKS, scoped: SCOPED_MOCKS } = mockRegistryKeys();
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
    // The add-on path's mocks. Blabber, Marketplace, Hodlr and Notes all reach the server
    // through `useService`, so a scan that found none of theirs is reading the wrong block.
    expect(SCOPED_MOCKS.size).toBeGreaterThan(10);
    // The declarative half specifically. If `createCrudStore` were renamed and this
    // collector quietly stopped matching, the dead-weight check would start failing for
    // reasons that have nothing to do with dead weight. The floor tracks the real count,
    // which moves down as well as up: Blabber's `followers`/`following` stores now read
    // through the `accounts` facet (MICA-16 step 4 — an add-on cannot name a NUI route
    // from inside the sandbox), so they declare no action name for this collector to find.
    // It moved down again for MICA-110: `mica_media` declares `paging`, which changes
    // the generic `get` reply from a bare array to `{ rows, nextCursor }`, so the gallery
    // is a `createPagedStore` now and its three CRUD names are no longer declared in the
    // shape this collector reads. They are still routed, still called, and still checked —
    // by `collectFetchNuiCalls` and the paged-store scanner below.
    // Down again for MICA-213: Mail and Places set `service:` so their contracted actions
    // ride the generic service action, and a store with `service:` declares no NUI name
    // for this collector to find. Contacts and Media are what is left on named routes.
    expect(CRUD_EVENTS.length).toBeGreaterThan(4);
    // The typed half is most of the surface now, so a scanner that found none of it would
    // make the MICA-213 block below vacuous.
    expect(TYPED_CALLS.length).toBeGreaterThan(50);
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
    // working in game — the same class of bug, pointing the other way. Since MICA-195
    // the transport no longer hides this at runtime either: an unmocked action rejects,
    // and `web/e2e/support/test.ts` fails the spec that provoked it. This is the static
    // half, and the only half that sees a call made with `quiet: true`.
    const missing = [...ROUTE_ACTIONS, ...CLIENT_ONLY_ACTIONS, ...UNIMPLEMENTED_ACTIONS].filter(
      (a) => !MOCKS.has(a)
    );
    expect(
      missing.toSorted(),
      'no browser mock answers this action, so the feature is dead in pnpm dev and in ' +
        'Playwright while working in game — add it to web/src/nui/mocks/registry.ts'
    ).toEqual([]);
  });

  it('every browser mock answers something the transport can actually carry', () => {
    // The reverse direction. A named mock nothing routes to is unreachable: `fetchNui`
    // with that name would work in the browser and hit no NUI callback in game, which is
    // the mock hiding a missing route, or it is dead weight left behind by a route that
    // was deleted — either way the registry is describing a surface that does not exist.
    const unrouted = [...MOCKS].filter((a) => !HANDLED.has(a));
    expect(
      unrouted.toSorted(),
      'this mock answers an action that is neither a route nor a client-only action, so ' +
        'nothing in game would answer the same call — route it, or delete the mock'
    ).toEqual([]);

    // A scoped mock claims the server answers `mica:server:<service>:<action>`. The
    // claim is checked against what the server really registered at import, the same
    // way the routes above are: a `'journal:archive'` mock with no such event answers a
    // call in the browser that the game would leave hanging for 15s.
    const unregistered = [...SCOPED_MOCKS]
      .map((key) => key.split(':') as [string, string])
      .filter(([service, action]) => !registeredServerEvents.has(requestEventFor(service, action)))
      .map(([service, action]) => `${service}:${action} -> ${requestEventFor(service, action)}`);
    expect(
      unregistered.toSorted(),
      'this scoped mock answers a generic service call the server never registered, so ' +
        'an add-on that works in the browser times out in game — register the action, ' +
        'or delete the mock'
    ).toEqual([]);
  });
});

/**
 * The typed call path (MICA-213): `call(<x>Contract, 'action', input)` over the generic
 * service action, in place of a string-named `fetchNui` plus a row in `shared/routes.ts`.
 *
 * A typed call has no route to check, so it is held to the two layers it does have: the
 * server must have registered `mica:server:<service>:<action>`, and the browser mock must
 * answer the scoped key `'<service>:<action>'`. The two ratchets below are what makes the
 * migration finish rather than stall: each number may only go down, and the ticket closes
 * when both are zero.
 */
describe('typed calls over the generic service action (MICA-213)', () => {
  const contracted = new Set(
    allContracts().flatMap((c) => Object.keys(c.actions).map((a) => `${c.id}:${a}`))
  );

  it('found at least the first typed call site, so the checks below are not vacuous', () => {
    expect(TYPED_CALLS.length).toBeGreaterThanOrEqual(1);
  });

  it('every typed call names an action its contract declares', () => {
    const undeclared = TYPED_CALLS.filter(
      ({ service, action }) => !contracted.has(`${service}:${action}`)
    );
    expect(undeclared.map((c) => `${c.service}:${c.action}  (${c.file})`).toSorted()).toEqual([]);
  });

  it('every typed call reaches a server event that is actually registered', () => {
    const missing = TYPED_CALLS.filter(
      ({ service, action }) => !registeredServerEvents.has(requestEventFor(service, action))
    );
    expect(
      missing.map((c) => `${c.service}:${c.action}  (${c.file})`).toSorted(),
      'the relay would forward this and the server would never answer'
    ).toEqual([]);
  });

  it('every typed call has a scoped browser mock', () => {
    const missing = TYPED_CALLS.filter(
      ({ service, action }) => !SCOPED_MOCKS.has(`${service}:${action}`)
    );
    expect(
      missing.map((c) => `'${c.service}:${c.action}'  (${c.file})`).toSorted(),
      'no scoped mock answers this, so the feature is dead in pnpm dev and in Playwright — ' +
        "add '<service>:<action>' to web/src/nui/mocks/registry.ts"
    ).toEqual([]);
  });

  /**
   * Ratchet one: routes that point at a contracted action. Each is a row `shared/routes.ts`
   * keeps by hand for an action the contract already declares, and the typed call makes
   * the row unnecessary. Lower the number as call sites migrate; never raise it.
   */
  const ROUTES_TO_CONTRACTED_ACTIONS = 0;
  it(`no more than ${ROUTES_TO_CONTRACTED_ACTIONS} routes still point at a contracted action`, () => {
    const remaining = ROUTES.filter((r) => contracted.has(`${r.service}:${r.serverAction}`));
    expect(remaining.length).toBeLessThanOrEqual(ROUTES_TO_CONTRACTED_ACTIONS);
  });

  /**
   * Ratchet two: string-named `fetchNui` calls in `web/src/services/` whose route points at
   * a contracted action — the call sites the typed `call` replaces. Same rule.
   */
  const STRING_CALLS_TO_CONTRACTED_ACTIONS = 0;
  it(`no more than ${STRING_CALLS_TO_CONTRACTED_ACTIONS} string-named calls in web/src/services/ reach a contracted action`, () => {
    const byAction = new Map(ROUTES.map((r) => [r.action, `${r.service}:${r.serverAction}`]));
    const remaining = collectFetchNuiCalls().filter(
      ({ action, file }) =>
        file.startsWith('web/src/services/') && contracted.has(byAction.get(action) ?? '')
    );
    expect(remaining.length).toBeLessThanOrEqual(STRING_CALLS_TO_CONTRACTED_ACTIONS);
  });
});
