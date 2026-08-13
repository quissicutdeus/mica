import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Core may not name an app.
 *
 * `boundary.test.ts` next door enforces the other direction — apps must not reach past
 * the SDK — and that half has been checked for a while. This half was not, and it drifted
 * three separate times before anything noticed:
 *
 *   - `sdk/utils.ts` exported `blabberTotalUnread`
 *   - `services/Accounts.ts` built a deep link with a hardcoded `'blabber'`
 *   - `lib/moderation.ts` listed `gphone_blabber` in the reportable allowlist
 *
 * Each was found by a person reading a diff, which is not a mechanism. The failure is
 * always the same shape: core needs some per-app fact, and a literal is the shortest way
 * to get it. The fix is always the same too — a registry the app declares into, the way
 * `registerService` and `registerReportable` already work.
 *
 * **Why it matters more than symmetry.** An app the Store installs is not in this
 * repository. Core cannot name it, so anything core does by naming an app is a thing that
 * works for the apps shipped in-tree and silently does not work for anybody else's. That
 * makes the add-on story half true in exactly the way the sibling test exists to prevent.
 *
 * ## The grandfather list is the point
 *
 * Blabber is `core: false` and yet the SDK ships `useBlabber`, core's services directory
 * holds its store, and `shared/routes.ts` carries nine of its routes. Those are real
 * violations and they are not small — they are the same finding as the three above, at a
 * scale that needs a design change rather than a patch, because an add-on cannot add a
 * hook to the SDK, a store to `services/`, or a row to the route table.
 *
 * So they are recorded rather than fixed here, and the list only goes down. What it
 * records is the honest size of "Blabber is an add-on": today it is a first-party app
 * wearing the label.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const REPO = join(ROOT, '..');

/**
 * Directories that must not name an app, and why each is core.
 *
 * `nui/mocks` is deliberately absent: a mock's whole job is to stand in for one app's
 * server, so naming apps is what it is for.
 */
const CORE_DIRS = [
  join(SRC, 'sdk'),
  join(SRC, 'shell'),
  join(SRC, 'services'),
  join(SRC, 'lib'),
  join(REPO, 'shared'),
  join(REPO, 'server', 'lib')
];

/**
 * Add-ons — the apps declaring `core: false`.
 *
 * **Not every app**, and the distinction is the whole rule. `contacts`, `media` and
 * `notes` ship with the phone, so core naming them is core naming part of itself; they
 * are also ordinary English words appearing across half the tree, which makes a blanket
 * rule both wrong and unusably noisy — the first version of this test flagged 55 files.
 *
 * An add-on is different in kind: it is not in this repository when a server installs it,
 * so core cannot name it and have that mean anything. That is the line worth enforcing.
 */
const addOnIds = (): string[] =>
  readdirSync(join(SRC, 'apps'))
    .filter((entry) => statSync(join(SRC, 'apps', entry)).isDirectory())
    .filter((id) => {
      try {
        return /core:\s*false/.test(readFileSync(join(SRC, 'apps', id, 'manifest.ts'), 'utf8'));
      } catch {
        return false;
      }
    });

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'mocks' || entry === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.(ts|svelte)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

const FILES = CORE_DIRS.flatMap(walk).map((path) => ({
  path: relative(REPO, path).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8')
}));

/**
 * Comments are not references.
 *
 * Several of these files explain *why* they no longer name an app, and a rule that made
 * the explanation illegal would delete the reasoning along with the violation.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Known violations, by file, as a count. Only ever goes down.
 *
 * Every line here is a thing a third-party app cannot do, so the list doubles as the
 * backlog for making the add-on path real.
 */
/**
 * Empty, and that is the finish line rather than an oversight.
 *
 * It held seven entries: an SDK hook and a core store for each of `notes` and `blabber`,
 * and thirteen rows in `shared/routes.ts`. Every one was a thing an app installed from the
 * Store could not do, so the list was the honest size of "Blabber is an add-on" — which it
 * was in name only.
 *
 * Both apps own their data layer now and reach their services through the generic route.
 * Core names neither. Leave this empty: an entry added back is a claim that some app needs
 * to be special, and the reason belongs in the comment beside it.
 */
const GRANDFATHERED: Record<string, number> = {};

const countFor = (text: string, ids: string[]): number => {
  const stripped = stripComments(text);
  return ids.reduce((total, id) => {
    const rx = new RegExp(`\\b${id}\\b`, 'g');
    return total + (stripped.match(rx) ?? []).length;
  }, 0);
};

describe('core may not name an app', () => {
  const ids = addOnIds();

  it('finds add-ons and core files to check', () => {
    // A scan that silently matched nothing would make every rule below vacuous — and this
    // one is one deleted manifest field away from matching nothing at all.
    expect(ids.length).toBeGreaterThan(0);
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('adds no new reference from core to an app', () => {
    const offenders = FILES.map(({ path, text }) => ({
      path,
      found: countFor(text, ids),
      allowed: GRANDFATHERED[path]
    }))
      .filter(({ found, allowed }) => found > (allowed ?? 0))
      .map(({ path, found, allowed }) => `${path}: ${found} (allowed ${allowed ?? 0})`);

    expect(
      offenders,
      'core cannot name an app the Store installs — have the app declare into a registry instead'
    ).toEqual([]);
  });

  it('has a grandfather list that only goes down', () => {
    // Without this the list rots exactly as `cef.test.ts` describes: a file that got
    // cleaner keeps its old budget, and the slack becomes room for a new violation.
    const stale = FILES.map(({ path, text }) => ({
      path,
      allowed: GRANDFATHERED[path],
      found: countFor(text, ids)
    }))
      .filter(({ allowed, found }) => allowed !== undefined && found < allowed)
      .map(({ path, allowed, found }) =>
        found === 0
          ? `${path}: now clean — delete the line`
          : `${path}: down to ${found} — lower the number from ${allowed}`
      );

    expect(stale).toEqual([]);

    for (const path of Object.keys(GRANDFATHERED)) {
      expect(
        FILES.some((f) => f.path === path),
        `${path} is grandfathered but no longer scanned — remove the entry`
      ).toBe(true);
    }
  });
});
