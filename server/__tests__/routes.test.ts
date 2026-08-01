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
   * `import '../controllers'` and record nothing, which is exactly the vacuous-pass
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

import '../controllers';

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
    for (const m of text.matchAll(/fetchNui\s*(?:<[^>]*>)?\s*\(\s*['"]([a-zA-Z][\w]*)['"]/g)) {
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
  const text = readFileSync(join(ROOT, 'web', 'src', 'mocks', 'registry.ts'), 'utf8');
  const body = text.slice(text.indexOf('mockRegistry'));
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s{2}([a-zA-Z][\w]*)\s*:/gm)) keys.add(m[1]);
  return keys;
};

const FETCH_CALLS = collectFetchNuiCalls();
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
      [...new Set(orphans.map(({ action, file }) => `${action}  (${file})`))].sort(),
      'web calls this and nothing answers it in game — the mock registry hides that'
    ).toEqual([]);
  });

  it('every route reaches a server event that is actually registered', () => {
    const missing = ROUTES.filter((r) => !registeredServerEvents.has(serverEventFor(r)));
    expect(
      missing.map((r) => `${r.action} -> ${serverEventFor(r)}`).sort(),
      'the client would forward this and the server would never answer, so the NUI ' +
        'callback hangs for 15s and then reports a timeout'
    ).toEqual([]);
  });

  it('every client-only action really is registered on the client', () => {
    const missing = CLIENT_ONLY_ACTIONS.filter((a) => !CLIENT_CALLBACKS.has(a));
    expect(missing.sort()).toEqual([]);
  });

  it('every unimplemented action still answers, rather than doing nothing', () => {
    // The promise of the unimplemented list is that the web is told, not that the
    // callback is absent. An absent one is exactly the silent no-op being outlawed.
    const missing = UNIMPLEMENTED_ACTIONS.filter((a) => !CLIENT_CALLBACKS.has(a));
    expect(missing.sort()).toEqual([]);
  });
});

describe('no dead weight', () => {
  it('every declared route is actually called by web/', () => {
    const called = new Set(FETCH_CALLS.map((c) => c.action));
    const unused = [...ROUTE_ACTIONS].filter((a) => !called.has(a));
    expect(unused.sort(), 'delete the route, or wire up the caller').toEqual([]);
  });

  it('every route and client-only action has a browser mock', () => {
    // Without a mock the feature is broken in `pnpm dev` and in Playwright while
    // working in game — the same class of bug, pointing the other way.
    const missing = [...ROUTE_ACTIONS, ...CLIENT_ONLY_ACTIONS, ...UNIMPLEMENTED_ACTIONS].filter(
      (a) => !MOCKS.has(a)
    );
    expect(missing.sort()).toEqual([]);
  });
});
