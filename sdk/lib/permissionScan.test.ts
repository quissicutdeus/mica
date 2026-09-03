// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  declaredPermissions,
  neededPermissions,
  permissionShortfall,
  sdkImportNames,
  shortfallMessage,
  type PermissionTable
} from './permissionScan';

/**
 * The derivation `permissions.test.ts` and both add-on builds share (MICA-205).
 *
 * `permissions.test.ts` drives the same functions over every app in the tree, which is the
 * check that matters and the one that would catch a real understatement. This file is the
 * other half: the shapes no in-tree manifest happens to be written in, and the guards that
 * only fire on input this repo does not contain.
 */

/** Small enough to reason about, and shaped like the real one — one row of each kind. */
const TABLE: PermissionTable = {
  useContacts: 'contacts',
  useMedia: 'media',
  useAppLevels: null,
  ReportDialog: ['reports', 'notifications']
};

describe('sdkImportNames', () => {
  it('reads the names out of an import list', () => {
    expect(sdkImportNames(`import { useContacts, Screen } from '@gos/sdk';`)).toEqual([
      'Screen',
      'useContacts'
    ]);
  });

  it('reads a list spread over several lines, and several statements', () => {
    const source = `
      import {
        useContacts,
        useMedia
      } from '@gos/sdk';
      import { Screen } from '@gos/sdk';
    `;
    expect(sdkImportNames(source)).toEqual(['Screen', 'useContacts', 'useMedia']);
  });

  it('resolves an alias back to the published name', () => {
    expect(sdkImportNames(`import { useContacts as contacts } from '@gos/sdk';`)).toEqual([
      'useContacts'
    ]);
  });

  it('reads double quotes, which is what a compiled component carries', () => {
    // The build scans a module's source as it enters the graph. A `.svelte` file whose
    // script has already been compiled has the same imports written with double quotes, so
    // a single-quote-only pattern would see nothing and pass every add-on.
    expect(sdkImportNames(`import { useMedia } from "@gos/sdk";`)).toEqual(['useMedia']);
  });

  it('strips a `type` specifier inside a value import', () => {
    expect(sdkImportNames(`import { useMedia, type Photo } from '@gos/sdk';`)).toEqual([
      'Photo',
      'useMedia'
    ]);
  });

  it('ignores a whole-statement type import', () => {
    // Nothing callable is imported, so nothing is disclosed. The pattern cannot match it
    // because `\\s*` after `import` will not absorb the keyword — asserted rather than
    // assumed, because it is a property of the regex rather than of an explicit branch.
    expect(sdkImportNames(`import type { Photo } from '@gos/sdk';`)).toEqual([]);
  });

  it('ignores an import that is commented out', () => {
    // The build fails on what this returns, so a false positive costs an author a
    // permission they do not need — which makes the sheet a player reads *less* true, not
    // more. Both comment forms go before anything is read.
    const source = `
      // import { useContacts } from '@gos/sdk';
      /* import { useMedia } from '@gos/sdk'; */
      import { Screen } from '@gos/sdk';
    `;
    expect(sdkImportNames(source)).toEqual(['Screen']);
  });

  it('ignores the other two entry points', () => {
    // `@gos/sdk/app` publishes `defineApp` and discloses nothing; `@gos/sdk/core` is
    // refused to an add-on outright, by a plugin that runs before this one.
    const source = `
      import { defineApp } from '@gos/sdk/app';
      import { useNuiBridge } from '@gos/sdk/core';
    `;
    expect(sdkImportNames(source)).toEqual([]);
  });

  it('finds nothing in a file that imports nothing from the SDK', () => {
    expect(sdkImportNames(`import { writable } from 'svelte/store';`)).toEqual([]);
  });
});

describe('declaredPermissions', () => {
  it('reads a literal list', () => {
    const source = `export default defineApp({ permissions: ['contacts', 'media'] });`;
    expect(declaredPermissions(source)).toEqual({ ok: true, permissions: ['contacts', 'media'] });
  });

  it('reads a list spread over several lines, past a doc comment', () => {
    const source = `
      export default defineApp({
        id: 'demo',
        /** What this app reaches for. Nothing here is a declaration: permissions: ['admin']. */
        permissions: [
          'contacts',
          'media'
        ],
        core: false
      });
    `;
    expect(declaredPermissions(source)).toEqual({ ok: true, permissions: ['contacts', 'media'] });
  });

  it('reads an empty list as an empty list', () => {
    expect(declaredPermissions(`defineApp({ permissions: [] })`)).toEqual({
      ok: true,
      permissions: []
    });
  });

  it('treats an absent `permissions` as declaring nothing', () => {
    // The field is optional and an app that omits it is making the narrowest claim there
    // is, which is the strictest thing to check imports against.
    expect(declaredPermissions(`defineApp({ id: 'demo', core: false })`)).toEqual({
      ok: true,
      permissions: []
    });
  });

  it('refuses a `permissions` it cannot read, rather than reading it as empty', () => {
    // The difference that matters: "declares nothing" passes an app with no permission-
    // bearing imports, and "cannot be read" must fail every time. Reading the second as the
    // first is how a build waves through exactly the manifest it should be looking hardest
    // at.
    const spread = declaredPermissions(`defineApp({ permissions: [...BASE, 'contacts'] })`);
    expect(spread.ok).toBe(false);

    const built = declaredPermissions(`defineApp({ permissions: buildPermissions() })`);
    expect(built.ok).toBe(false);

    const variable = declaredPermissions(`defineApp({ permissions: ['contacts', EXTRA] })`);
    expect(variable.ok).toBe(false);
  });

  it('says why, in words an author can act on', () => {
    const result = declaredPermissions(`defineApp({ permissions: buildPermissions() })`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('literal array');
  });
});

describe('neededPermissions', () => {
  it('maps an import to the permission that discloses it', () => {
    expect(neededPermissions(['useContacts'], TABLE)).toEqual([
      { hook: 'useContacts', permission: 'contacts' }
    ]);
  });

  it('expands a row that names more than one', () => {
    // A kit component can call several host hooks at init; `ReportDialog` calls two.
    expect(neededPermissions(['ReportDialog'], TABLE)).toEqual([
      { hook: 'ReportDialog', permission: 'notifications' },
      { hook: 'ReportDialog', permission: 'reports' }
    ]);
  });

  it('skips the implicit rows and the names with no row at all', () => {
    // `useAppLevels` is one of the handful every app is built out of and is never declared;
    // `Screen` is a component and discloses nothing. A hook with *no* row is a failure in
    // `permissions.test.ts`, which proves the table total — not a silent pass here.
    expect(neededPermissions(['useAppLevels', 'Screen'], TABLE)).toEqual([]);
  });

  it('refuses a table that failed to arrive', () => {
    // MICA-124's shape, in the worst direction: an empty table maps nothing, so a build
    // plugin holding one would wave through every add-on ever submitted and report nothing.
    expect(() => neededPermissions(['useContacts'], {})).toThrow(/empty or failed to import/);
  });
});

describe('permissionShortfall', () => {
  it('is empty when the manifest declares what the code reaches for', () => {
    expect(permissionShortfall(['useContacts'], ['contacts'], TABLE)).toEqual([]);
  });

  it('is empty when the manifest declares more than the code reaches for', () => {
    // AGENTS.md §7: over-declaring is untidy, not a lie. It must never fail a build.
    expect(permissionShortfall(['useContacts'], ['contacts', 'media'], TABLE)).toEqual([]);
  });

  it('reports only the half of a multi-permission row that is missing', () => {
    expect(permissionShortfall(['ReportDialog'], ['reports'], TABLE)).toEqual([
      { hook: 'ReportDialog', permission: 'notifications' }
    ]);
  });

  it('names the import as well as the permission', () => {
    expect(permissionShortfall(['useMedia'], [], TABLE)).toEqual([
      { hook: 'useMedia', permission: 'media' }
    ]);
  });
});

describe('shortfallMessage', () => {
  it('names the app, the import, the permission and the file to edit', () => {
    const message = shortfallMessage('demo', 'src/manifest.ts', [
      { hook: 'useMedia', permission: 'media' }
    ]);
    expect(message).toContain('demo');
    expect(message).toContain('useMedia');
    expect(message).toContain("'media'");
    expect(message).toContain('src/manifest.ts');
  });
});

describe('an out-of-tree add-on build can load this', () => {
  /**
   * The constraint this whole module is shaped by, asserted against a real Node rather than
   * inferred from the source.
   *
   * `tools/addon-template/vite.config.ts` runs in Node, not in Vite's pipeline, and reaches
   * these two files by path. Node 26 loads a `.ts` file — type stripping is on by default —
   * but it will not resolve an extensionless relative specifier inside one. So the day
   * somebody adds an ordinary `import { x } from './y'` to either file, every add-on built
   * outside this repo fails with `ERR_MODULE_NOT_FOUND` naming a file its author has never
   * seen, and nothing else in this repo would notice. Reading the source for the string
   * `import` would be the cheap version of this check and would prove nothing about
   * resolution; this runs the resolver.
   *
   * `sdk/permissions.ts` is in the list because the template loads it the same way, for
   * `PERMISSION_OF`. It is a plain table with one type-only import today, and nothing but
   * this says it has to stay that way.
   */
  const SDK_DIR = join(__dirname, '..');

  for (const file of ['lib/permissionScan.ts', 'permissions.ts']) {
    it(`loads \`sdk/${file}\` under plain Node, with no bundler`, () => {
      const url = pathToFileURL(join(SDK_DIR, file)).href;
      const loaded = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(url)}); console.log(Object.keys(m).length);`
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      expect(Number(loaded.trim())).toBeGreaterThan(0);
    });
  }
});
