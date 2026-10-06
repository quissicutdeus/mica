// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkAddonService } from '@mica/shared/addonService';
import {
  ADDON_DEV_ENTRY,
  MICA_ADDON_MOCK_MARKER,
  parseLoopbackBase,
  sameOriginAs
} from '@mica/shared/addonDev';
import { isCatalogEntry } from '../../../sdk/catalog';
import { NOTE_ADDED, notes } from '../../../tools/addon-template/src/service';

/**
 * The out-of-tree add-on template must keep saying what this repo's add-on build says.
 *
 * MICA-175. `tools/addon-template/` is a standalone project an author fetches with
 * `degit` and builds with no clone of this repo. Its `vite.config.ts` is a **copy** of
 * `web/vite.addon.config.ts`'s decisions, and it has to be a copy rather than an import:
 * the phone's config lives in the `web` workspace, which the author does not have, and the
 * only two packages they do have (`@mica/sdk`, `@mica/shared`) deliberately publish no
 * build tooling.
 *
 * A copy drifts. The failure mode is specific and bad: an add-on built out of tree that
 * *works* — installs, boots, renders in a browser — and differs from an in-tree bundle in
 * one of the handful of ways that only show up in FiveM's CEF or under the Store's loader.
 * Raise `build.target` past `chrome92` and the bundle throws in game. Lose
 * `codeSplitting: false` and it emits a shared chunk the `data:`-URL loader can never
 * fetch. Lose `inlineCss` and the stylesheet is an asset nothing loads. Lose the `define`
 * block and every published add-on reads a confidently wrong `MICA_VERSION`, which is
 * MICA-170 happening a second time to somebody who cannot see this repo. None of those
 * fails a build, and no suite an author can run would notice.
 *
 * ## What this reads, and what it cannot
 *
 * It compares **source text**, not behaviour. Both files are read from disk and each knob
 * below is required to appear in each — so a value changed on one side and not the other
 * fails here, which is the drift this exists for.
 *
 * It cannot see: a plugin whose body has changed while its name and options stayed put; a
 * knob added to one config that neither side's list here mentions; or anything about
 * whether the emitted bundles actually match, which needs an out-of-tree build and is not
 * something a unit test can run. Those are review questions. This is the cheap gate that
 * catches the common one — somebody editing `vite.addon.config.ts` and not knowing the
 * template exists — and its whole value is that it names the file to go and edit.
 *
 * Importing the two configs and diffing the resolved objects would be stronger and was
 * tried. It does not work: the template's config resolves `@mica/sdk` and
 * `@sveltejs/vite-plugin-svelte` from `tools/addon-template/node_modules`, which exists
 * only after an author installs, and is not present in this repo's tree at all.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PHONE_CONFIG = path.join(ROOT, 'web/vite.addon.config.ts');
const TEMPLATE_DIR = path.join(ROOT, 'tools/addon-template');
const TEMPLATE_CONFIG = path.join(TEMPLATE_DIR, 'vite.config.ts');

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/** MICA-312. The SDK's checker, by its path inside the package. */
const CHECK_CLI = 'checks/cli.js';
/** What the checker needs installed beside it, all three resolved from the add-on's project. */
const CHECK_TOOLING = ['stylelint', 'stylelint-no-unsupported-browser-features', 'postcss-html'];

/** A pattern matching `text` exactly, for a decision both files spell the same way. */
const literal = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));

/**
 * Every decision that changes what a bundle *is* rather than how it was produced.
 *
 * A pattern, not a literal string, so incidental formatting differences between the two
 * files do not fail this — the two configs are written for different readers and are not
 * expected to be character-identical anywhere except in what they decide.
 */
const SHARED_DECISIONS: [name: string, pattern: RegExp][] = [
  // Chromium 103 is FiveM's release CEF; `chrome92` is the floor this repo builds to,
  // deliberately below it. Raising it is the single most dangerous silent divergence here.
  ['build.target is chrome92', /target:\s*'chrome92'/],
  // One chunk per entry. The add-on iframe loads a `data:` module URL and has no way to
  // fetch a sibling.
  ['output.codeSplitting is false', /codeSplitting:\s*false/],
  ['output.preserveModules is false', /preserveModules:\s*false/],
  // The stylesheet has to end up inside the chunk; there is no document to `<link>` from.
  ['build.cssCodeSplit is false', /cssCodeSplit:\s*false/],
  ['the CSS is inlined into the entry chunk', /document\.createElement\('style'\)/],
  // Always, `--watch` included: the bundle text is what gets `encodeURIComponent`d.
  ['build.minify is true', /minify:\s*true/],
  ['the output is a single ES lib entry', /formats:\s*\['es'\]/],
  // MICA-170. Both identifiers substituted, both with the empty string, on both sides.
  ['__MICA_VERSION__ is defined as the empty string', /__MICA_VERSION__:\s*JSON\.stringify\(''\)/],
  [
    '__MICA_BUILD_INFO__ is defined as the empty string',
    /__MICA_BUILD_INFO__:\s*JSON\.stringify\(''\)/
  ],
  ['no `__MICA_*__` identifier may survive into the output', /__MICA_\[A-Za-z0-9_\]\*__/],
  // Neither package declares `sideEffects: false`, so without this every add-on ships a
  // Markdown parser and a sanitiser whether or not it renders Markdown.
  ['marked and dompurify are treeshaken as side-effect-free', /marked\|dompurify/],
  ['resolution prefers the browser condition', /conditions:\s*\['browser'\]/],
  // AGENTS.md §2.7. The one divergence that would be a privilege-escalation route rather
  // than a rendering bug.
  ['@mica/sdk/core is refused', /@mica\\\/sdk\\\/core\(\\\/\.\*\)\?\$/],
  // MICA-205. A bundle may not declare fewer permissions than its imports reach for.
  // Understating buys no access — the shell re-checks every permission against
  // `HOOK_OF_FACET` — but it makes the Store's install sheet untrue, and the population
  // that sheet exists for builds out of tree. A build with the check and a build without it
  // are the same bundle right up until an author omits a permission.
  ['the permission scan runs as a build plugin', /name:\s*'mica-addon-permissions'/],
  ['a shortfall against the permission table fails the build', /permissionShortfall\(/],
  /**
   * MICA-190. A manifest property is read from comment-stripped text, on both sides.
   *
   * Both builds classify a manifest by reading its source, because neither can evaluate one
   * — a manifest imports a Svelte component. A doc comment is exactly where the word `core`
   * gets discussed, so a raw grep answers from the prose. The template hit that loudly on
   * its own sample manifest; the phone had it silently and pointing the other way, where a
   * `core: true` app whose comment contains `core: false` is emitted as an installable
   * add-on and §2.7's gate on `@mica/sdk/core` rests on a comment.
   *
   * The alternation is the decision showing up under two names rather than a weakened
   * check: the template strips inline, while the phone's config delegates the whole of
   * discovery to `web/scripts/addon-ids.js` (which strips, and which `build-addons.mjs`
   * shares). Either spelling here means the text was cleaned before a property was read;
   * neither means it was not.
   */
  ['a manifest property is read from comment-stripped text', /withoutComments|addon-ids\.js/],
  /**
   * MICA-311. The in-frame service mock never ships. The template allows it in development
   * mode only and the phone's build never, but both refuse it the same three ways: the
   * specifier, the files behind it however reached, and the mock's runtime marker in the
   * finished chunk — the last being the only one that catches a mock pasted into source.
   */
  ['@mica/sdk/dev is refused by a build plugin', literal("name: 'mica-refuse-dev-entry'")],
  ['the @mica/sdk/dev specifier is refused', literal(String.raw`/^@mica\/sdk\/dev(\/.*)?$/`)],
  [
    'the files behind @mica/sdk/dev are refused however reached',
    literal(String.raw`/\/sdk\/(dev\.ts|host\/iframe\/devMock\.ts)$/`)
  ],
  [
    "the mock's runtime marker is refused in the finished chunk",
    literal(`const MOCK_MARKER = '${MICA_ADDON_MOCK_MARKER}';`)
  ]
];

describe('the out-of-tree add-on template', () => {
  it('is on disk, with the files an author is told they will get', () => {
    // Non-vacuity: every assertion below reads one of these, so a missing template would
    // otherwise make this whole file pass by comparing nothing.
    for (const file of [
      'README.md',
      'package.json',
      'pnpm-workspace.yaml',
      'postcss.config.js',
      'svelte.config.js',
      'tsconfig.json',
      'vite.config.ts',
      'src/manifest.ts',
      'src/index.svelte',
      'src/Icon.svelte',
      // MICA-308: the example server half.
      'src/service.ts',
      // MICA-311: its in-frame mock, and the dev loop that serves it.
      'src/mock.ts',
      'scripts/dev.mjs',
      'my_addon_server/fxmanifest.lua',
      'my_addon_server/server.lua',
      'my_addon_server/service.json'
    ]) {
      expect(fs.existsSync(path.join(TEMPLATE_DIR, file)), `${file} is missing`).toBe(true);
    }
  });

  it('decides the same things about a bundle that web/vite.addon.config.ts does', () => {
    const phone = read(PHONE_CONFIG);
    const template = read(TEMPLATE_CONFIG);
    expect(phone.length).toBeGreaterThan(1000);
    expect(template.length).toBeGreaterThan(1000);

    const missing = SHARED_DECISIONS.flatMap(([name, pattern]) => [
      ...(pattern.test(phone) ? [] : [`web/vite.addon.config.ts no longer says: ${name}`]),
      ...(pattern.test(template)
        ? []
        : [`tools/addon-template/vite.config.ts no longer says: ${name}`])
    ]);

    expect(
      missing,
      "the phone's add-on build and the out-of-tree template have diverged. An add-on " +
        'built from the template is installed and run by this phone, so a decision that ' +
        'holds in one and not the other produces a bundle that builds, boots, and is wrong ' +
        "in a way only FiveM's CEF or the Store loader sees. Change both, or — if the " +
        'divergence is deliberate — take the entry out of SHARED_DECISIONS with the reason.'
    ).toEqual([]);
  });

  it('lowers CSS to the Chromium 103 baseline, as the phone does', () => {
    /**
     * `web/postcss.config.js` sits at the root Vite discovers from, so the phone's add-on
     * build inherits it without naming it. Out of tree there is nothing to inherit from,
     * and the consequence is not cosmetic: `sdk/app-utilities.css` nests, native nesting is
     * Chromium 112, and the SDK stylesheet is inlined into every add-on bundle. A template
     * without this file produces an add-on that renders correctly everywhere an author can
     * look and drops thirty-odd rule blocks in game.
     */
    const phone = read(path.join(ROOT, 'web/postcss.config.js'));
    const template = read(path.join(TEMPLATE_DIR, 'postcss.config.js'));
    for (const feature of ['nesting-rules', 'oklab-function', 'color-functional-notation']) {
      expect(phone, `web/postcss.config.js dropped ${feature}`).toContain(feature);
      expect(
        template,
        `tools/addon-template/postcss.config.js dropped ${feature} — an add-on built from ` +
          'the template would ship CSS the game cannot parse'
      ).toContain(feature);
    }
  });

  it('names one git ref for both unpublished packages', () => {
    /**
     * `@mica/sdk` and `@mica/shared` are separate packages that share a wire
     * vocabulary, and the SDK re-exports from `shared`. Installing them from two different
     * commits typechecks in the easy cases and is wrong in the interesting ones, so the
     * dependency, the second dependency and the `overrides` entry that redirects the SDK's
     * own `workspace:*` all have to name the same ref. Three places, edited by hand, is
     * exactly the shape that drifts.
     */
    const pkg = JSON.parse(read(path.join(TEMPLATE_DIR, 'package.json'))) as {
      dependencies: Record<string, string>;
    };
    const workspace = read(path.join(TEMPLATE_DIR, 'pnpm-workspace.yaml'));

    const refOf = (spec: string): string | undefined =>
      /^github:quissicutdeus\/mica#([^&]+)&path:\/(sdk|shared)$/.exec(spec)?.[1];

    const sdkRef = refOf(pkg.dependencies['@mica/sdk'] ?? '');
    const sharedRef = refOf(pkg.dependencies['@mica/shared'] ?? '');
    const overrideSpec = /'@mica\/shared':\s*'([^']+)'/.exec(workspace)?.[1] ?? '';
    const overrideRef = refOf(overrideSpec);

    expect(sdkRef, '@mica/sdk is not a github:…#<ref>&path:/sdk specifier').toBeDefined();
    expect([sharedRef, overrideRef]).toEqual([sdkRef, sdkRef]);

    /**
     * Not a formality either: `blockExoticSubdeps` defaults to true in pnpm 11 and refuses
     * a git dependency reached through an override, and pnpm 11 ignores a `pnpm` field in
     * `package.json` outright — so both settings have to be in this file or `pnpm install`
     * fails on a fresh checkout of the author's project, talking about a workspace that is
     * not theirs.
     */
    expect(workspace).toContain('blockExoticSubdeps: false');
    expect(pkg).not.toHaveProperty('pnpm');
  });

  /**
   * MICA-308. The template's server half reads its declaration as JSON, because it is Lua and
   * cannot read `src/service.ts`; the template's build writes that JSON from the `.ts`. Both
   * files are committed so the folder works the moment it is copied, which makes the JSON a
   * second copy in this repo — and a second copy is the shape that drifts. Each test below is
   * one way the example would stop working for whoever copies it, with nothing in their own
   * build to say so.
   */
  describe('the example server half', () => {
    const serverDir = path.join(TEMPLATE_DIR, 'my_addon_server');
    const committed = read(path.join(serverDir, 'service.json'));
    const lua = read(path.join(serverDir, 'server.lua'));

    it('ships the JSON the build would write from src/service.ts', () => {
      // The plugin's own encoding, so a rebuild of the template is a no-op here. A mismatch
      // means `service.ts` was edited and `pnpm build` not run in the template.
      expect(
        committed,
        'tools/addon-template/my_addon_server/service.json is not what src/service.ts declares — ' +
          'build the template, or regenerate it with the same JSON.stringify(declaration, null, 2)'
      ).toBe(`${JSON.stringify(notes, null, 2)}\n`);
    });

    it('is a declaration micaOS accepts, under the manifest id', () => {
      const parsed: unknown = JSON.parse(committed);
      const checked = checkAddonService(parsed);
      expect(checked, checked.ok ? '' : checked.reason).toMatchObject({ ok: true });
      const manifestId = /^\s*id:\s*'([a-z][a-z0-9_]*)'/m.exec(
        read(path.join(TEMPLATE_DIR, 'src/manifest.ts'))
      )?.[1];
      expect(manifestId).toBeDefined();
      expect(notes.id).toBe(manifestId);
    });

    it('declares the service from a module the build can evaluate without Svelte', () => {
      // The plugin runs `src/service.ts` through Vite's module runner, which has no Svelte
      // plugin: an import of `@mica/sdk` there reaches the component barrel and the build
      // fails. `@mica/shared/addonService` imports nothing but `@mica/shared/schema`.
      const source = read(path.join(TEMPLATE_DIR, 'src/service.ts'));
      expect(source).toMatch(/from '@mica\/shared\/addonService';/);
      expect(source).not.toMatch(/from '@mica\/sdk/);
    });

    it('writes the JSON into the folder the Lua resource loads it from', () => {
      const config = read(TEMPLATE_CONFIG);
      expect(config).toContain("name: 'mica-addon-service-json'");
      expect(config).toContain("path.join(here, 'my_addon_server')");
      expect(config).toContain("path.join(SERVER_RESOURCE, 'service.json')");
      expect(lua).toMatch(/LoadResourceFile\(RESOURCE, 'service\.json'\)/);
    });

    it("registers and pushes through the exports micaOS publishes, with the UI's event name", () => {
      // Names micaOS actually publishes, read from where it publishes them.
      const api = read(path.join(ROOT, 'server/lib/publicApi.ts'));
      for (const name of ['RegisterService', 'PushToApp']) {
        expect(api, `micaOS no longer publishes ${name}`).toContain(`'${name}',`);
      }
      expect(lua).toMatch(/exports\.mica:RegisterService\(declaration, handlers\)/);
      expect(lua).toContain(
        `exports.mica:PushToApp(declaration.id, citizenid, '${NOTE_ADDED}', note)`
      );
      // Every declared action has a handler, and nothing else does — `RegisterService`
      // refuses either mismatch, and only on a running server.
      const handlers = [...lua.matchAll(/^ {2}([a-zA-Z_]+) = function\(citizenid/gm)].map(
        (m) => m[1]
      );
      expect(handlers.sort()).toEqual(Object.keys(notes.actions).sort());
      // The add-on hears its pushes through `useAppEvents`, which the manifest must declare.
      expect(read(path.join(TEMPLATE_DIR, 'src/manifest.ts'))).toMatch(
        /permissions:\s*\[[^\]]*'app-events'/
      );
    });
  });

  /**
   * MICA-311. `pnpm dev`: a watch build in development mode, served on loopback, opened by the
   * demo phone through `?addonDev=`. Read as text: the script starts servers, and what it must
   * get right is a handful of literals the phone and the README both depend on.
   */
  describe('the dev loop', () => {
    const script = read(path.join(TEMPLATE_DIR, 'scripts/dev.mjs'));

    it('is what `pnpm dev` runs', () => {
      const pkg = JSON.parse(read(path.join(TEMPLATE_DIR, 'package.json'))) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts.dev).toBe('node scripts/dev.mjs');
    });

    it('serves on a loopback base the phone accepts, on a port that fails loudly when taken', () => {
      const host = /const HOST = '([^']+)';/.exec(script)?.[1];
      const port = /const PORT = (\d+);/.exec(script)?.[1];
      expect([host, port]).toEqual(['127.0.0.1', '5174']);
      expect(parseLoopbackBase(`http://${host}:${port}/`)).toMatchObject({ ok: true });
      expect(script).toMatch(/strictPort:\s*true/);
      expect(script).toMatch(/mode:\s*'development'/);
    });

    it('lets the public demo reach it, Private Network Access included', () => {
      expect(script).toContain("'https://mica.gg'");
      expect(script).toContain("'Access-Control-Allow-Private-Network', 'true'");
      expect(script).toContain("const DEMO = 'https://mica.gg/demo/';");
      expect(script).toContain('?addonDev=${BASE}');
    });

    it('imports nothing an author would have to install', () => {
      const specifiers = [...script.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(specifiers.sort()).toEqual(['node:path', 'vite']);
    });
  });

  /**
   * MICA-312. `pnpm check` is where the CEF floor and the utility-class scan reach an author:
   * `svelte-check`, then `@mica/sdk`'s own checker, which runs the same code this repo's
   * `utilityClasses.test.ts` and `sdk/cef.test.ts` call, and stylelint with the same config
   * this repo's `stylelint.config.js` spreads. What is pinned here is the wiring an author
   * cannot see break: the script, and the tooling it needs at the versions this repo runs.
   */
  describe('pnpm check', () => {
    const pkg = JSON.parse(read(path.join(TEMPLATE_DIR, 'package.json'))) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const rootPkg = JSON.parse(read(path.join(ROOT, 'package.json'))) as {
      devDependencies: Record<string, string>;
    };

    it('runs svelte-check and the SDK checker, and fails if either does', () => {
      expect(pkg.scripts.check).toBe(
        'svelte-check --tsconfig ./tsconfig.json --fail-on-warnings && ' +
          `node node_modules/@mica/sdk/${CHECK_CLI} src`
      );
      expect(fs.existsSync(path.join(ROOT, 'sdk', CHECK_CLI))).toBe(true);
      // Published, or `node_modules/@mica/sdk/checks/cli.js` is not there to run.
      const sdkPkg = JSON.parse(read(path.join(ROOT, 'sdk/package.json'))) as {
        files: string[];
        exports: Record<string, string>;
      };
      expect(sdkPkg.files).toContain('checks/*.js');
      expect(sdkPkg.exports['./stylelint']).toBe('./checks/stylelint.config.js');
    });

    it('installs the stylelint toolchain at the versions this repo lints with', () => {
      for (const name of CHECK_TOOLING) {
        expect(pkg.devDependencies[name], `${name} in the template`).toBeDefined();
        expect(pkg.devDependencies[name], `${name} has drifted from this repo's`).toBe(
          rootPkg.devDependencies[name]
        );
      }
    });

    it("lints with the SDK's config, as this repo does", () => {
      expect(read(path.join(ROOT, 'stylelint.config.js'))).toContain(
        "import cefFloor from './sdk/checks/stylelint.config.js';"
      );
    });
  });

  /**
   * The template copied out of this tree with its `node_modules` as links — `@mica/sdk` and
   * `@mica/shared` to this tree, the toolchain to `web/`'s copies — so it reads exactly the SDK
   * this commit holds and fetches nothing. `more` links further packages by absolute path, and
   * `bin` puts a package's executable on the copy's `node_modules/.bin`, as an install would.
   */
  const TOOLCHAIN = [
    'vite',
    'svelte',
    'postcss',
    'postcss-preset-env',
    'autoprefixer',
    '@sveltejs/vite-plugin-svelte',
    '@tsconfig/svelte'
  ];
  const made: string[] = [];

  const copyTemplate = (
    extra: Record<string, string> = {},
    more: Record<string, string> = {},
    bin: Record<string, string> = {}
  ): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mica-addon-template-'));
    made.push(dir);
    fs.cpSync(TEMPLATE_DIR, dir, {
      recursive: true,
      filter: (src) =>
        !/^(node_modules|dist|dist-dev)(\/|\\|$)/.test(path.relative(TEMPLATE_DIR, src))
    });
    const link = (name: string, target: string) => {
      const at = path.join(dir, 'node_modules', name);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(target, at, fs.statSync(target).isDirectory() ? 'dir' : 'file');
    };
    link('@mica/sdk', path.join(ROOT, 'sdk'));
    link('@mica/shared', path.join(ROOT, 'shared'));
    for (const name of TOOLCHAIN) {
      link(name, fs.realpathSync(path.join(ROOT, 'web/node_modules', name)));
    }
    for (const [name, target] of Object.entries(more)) link(name, fs.realpathSync(target));
    for (const [name, target] of Object.entries(bin)) link(`.bin/${name}`, fs.realpathSync(target));
    for (const [file, text] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    return dir;
  };

  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * MICA-311. The template, built for real in both modes, against this checkout.
   *
   * Offline: the template is copied out and its `node_modules` is links — `@mica/sdk` and
   * `@mica/shared` to this tree, the toolchain to `web/`'s copies — so the build reads exactly
   * the SDK this commit holds and fetches nothing. Each build is a child Node running Vite's own
   * CLI, as an author's `pnpm build` would, rather than Vite inside this Vitest process.
   *
   * What it proves that nothing else does: a production bundle carries no trace of the mock,
   * a development bundle does, `mica-dev.json` is an entry the phone keeps for the bytes beside
   * it, and each route by which a production build could pull the mock in is refused.
   */
  describe('built offline, in production and in development', () => {
    const VITE_BIN = path.join(ROOT, 'web/node_modules/vite/bin/vite.js');
    /** A Vite build as its own process, without this runner's `NODE_ENV=test`. */
    const viteBuild = (dir: string, mode: 'production' | 'development', args: string[] = []) =>
      new Promise<{ code: number; output: string }>((resolve) => {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV' && !k.startsWith('VITEST'))
        );
        execFile(
          process.execPath,
          [VITE_BIN, 'build', '--mode', mode, ...args],
          { cwd: dir, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ code, output: `${stdout}\n${stderr}` });
          }
        );
      });

    /** A source file of the author's that pulls something in, wired from the component. */
    const sneaking = (body: string) => {
      const component = read(path.join(TEMPLATE_DIR, 'src/index.svelte'));
      return {
        'src/sneak.ts': body,
        'src/index.svelte': component.replace(
          '<script lang="ts">',
          `<script lang="ts">\n  import './sneak';`
        )
      };
    };

    const builds: Record<string, { dir: string; code: number; output: string }> = {};

    beforeAll(async () => {
      const cases: [string, Record<string, string>, 'production' | 'development', string[]?][] = [
        ['production', {}, 'production'],
        ['development', {}, 'development'],
        // A dev session's leftovers in `dist/`, as an older template wrote them there.
        [
          'stale',
          {
            [`dist/${notes.id}.js`]: `console.log('${MICA_ADDON_MOCK_MARKER}');\n`,
            [`dist/${ADDON_DEV_ENTRY}`]: '{}\n'
          },
          'production'
        ],
        // Pointed back at `dist/` by hand: the dev output still goes to `dist-dev/`.
        ['dev into dist', {}, 'development', ['--outDir', 'dist']],
        [
          'specifier',
          sneaking(
            `import { installAddonMock } from '@mica/sdk/dev';\nconsole.log(installAddonMock);\n`
          ),
          'production'
        ],
        [
          'deep path',
          sneaking(
            `import { installAddonMock } from '../node_modules/@mica/sdk/host/iframe/devMock';\n` +
              `console.log(installAddonMock);\n`
          ),
          'production'
        ],
        ['marker', sneaking(`console.log('${MICA_ADDON_MOCK_MARKER}');\n`), 'production']
      ];
      await Promise.all(
        cases.map(async ([name, extra, mode, args]) => {
          const dir = copyTemplate(extra);
          builds[name] = { dir, ...(await viteBuild(dir, mode, args)) };
        })
      );
    }, 180_000);

    const bundleOf = (name: string, folder: 'dist' | 'dist-dev' = 'dist'): string =>
      read(path.join(builds[name].dir, folder, `${notes.id}.js`));
    const devEntryOf = (name: string): string =>
      path.join(builds[name].dir, 'dist-dev', ADDON_DEV_ENTRY);

    it('builds for production with no trace of the mock and no dev catalog entry', () => {
      expect(builds.production.code, builds.production.output).toBe(0);
      expect(bundleOf('production').length).toBeGreaterThan(10_000);
      expect(bundleOf('production')).not.toContain(MICA_ADDON_MOCK_MARKER);
      expect(fs.existsSync(path.join(builds.production.dir, 'dist', ADDON_DEV_ENTRY))).toBe(false);
    });

    it('builds for development into dist-dev/, with the mock in the bundle', () => {
      expect(builds.development.code, builds.development.output).toBe(0);
      expect(bundleOf('development', 'dist-dev')).toContain(MICA_ADDON_MOCK_MARKER);
      expect(fs.existsSync(devEntryOf('development'))).toBe(true);
    });

    it.each(['development', 'dev into dist'])(
      'never writes development output into dist/, the folder an author publishes (%s)',
      (name) => {
        expect(builds[name].code, builds[name].output).toBe(0);
        expect(fs.existsSync(path.join(builds[name].dir, 'dist'))).toBe(false);
        expect(bundleOf(name, 'dist-dev')).toContain(MICA_ADDON_MOCK_MARKER);
      }
    );

    it("clears a dev session's leftovers out of dist/ in a production build", () => {
      expect(builds.stale.code, builds.stale.output).toBe(0);
      expect(fs.existsSync(path.join(builds.stale.dir, 'dist', ADDON_DEV_ENTRY))).toBe(false);
      expect(bundleOf('stale')).not.toContain(MICA_ADDON_MOCK_MARKER);
      expect(bundleOf('stale').length).toBeGreaterThan(10_000);
    });

    it('writes a dev catalog entry the phone keeps, for the exact bytes beside it', () => {
      const raw: unknown = JSON.parse(read(devEntryOf('development')));
      expect(isCatalogEntry(raw), JSON.stringify(raw)).toBe(true);
      const entry = raw as { id: string; sha256: string; bundleUrl: string; permissions: string[] };
      expect(entry.id).toBe(notes.id);
      expect(entry.permissions).toEqual(['app-events']);
      const bytes = fs.readFileSync(
        path.join(builds.development.dir, 'dist-dev', `${notes.id}.js`)
      );
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      // Relative, so it resolves against whichever loopback address served the entry.
      const base = parseLoopbackBase('http://127.0.0.1:5174/');
      if (!base.ok) throw new Error(base.reason);
      expect(entry.bundleUrl).toMatch(new RegExp(`^${notes.id}\\.js\\?v=[0-9a-f]{16}$`));
      expect(sameOriginAs(base.base, entry.bundleUrl)).toBe(true);
    });

    it.each([
      ['the @mica/sdk/dev specifier', 'specifier', /'@mica\/sdk\/dev' is imported/],
      ['a deep relative path to the mock', 'deep path', /devMock\.ts is in the module graph/],
      ['the mock marker pasted into source', 'marker', /carries the mock's marker/]
    ])('refuses a production build that reaches %s', (_label, name, reason) => {
      expect(builds[name].code, builds[name].output).not.toBe(0);
      expect(builds[name].output).toMatch(reason);
    });
  });

  /**
   * MICA-312. `pnpm check`, run for real over copies of the template, offline.
   *
   * The script is read out of the template's `package.json` and run by a shell with the
   * copy's `node_modules/.bin` first on `PATH`, as `pnpm check` would — so a script that names
   * a missing binary or a wrong path fails here. The toolchain is this repo's: `svelte-check`
   * and TypeScript from `web/`, stylelint and its two companions from the root.
   *
   * The ticket's own acceptance: a planted `:has()`, a `dvh`, a misspelt utility class and an
   * `h-full` inside `Screen` each fail it by name, and the same file with each fixed passes —
   * in a component, and (`:has()`, `svh`, a container query, `rgb(from …)`) in a plain `.css`.
   */
  describe('pnpm check, run offline over a clean, a planted and a fixed copy', () => {
    const CHECK_TOOLCHAIN = Object.fromEntries([
      ...['svelte-check', 'typescript', '@types/node'].map((name) => [
        name,
        path.join(ROOT, 'web/node_modules', name)
      ]),
      ...CHECK_TOOLING.map((name) => [name, path.join(ROOT, 'node_modules', name)])
    ]) as Record<string, string>;
    const CHECK_BIN = {
      'svelte-check': path.join(ROOT, 'web/node_modules/svelte-check/bin/svelte-check')
    };

    const component = read(path.join(TEMPLATE_DIR, 'src/index.svelte'));
    /**
     * `:has()` at 1, `svh` at 5, a container query at 7, relative colour at 13, and at 16 a
     * `scrollbar-width`, which leaves scrollbars visible in Chromium 103 on its own.
     */
    const PLANTED_CSS = [
      '.sheet:has(p) {',
      '  color: red;',
      '}',
      '.sheet {',
      '  min-height: 100svh;',
      '}',
      '@container (min-width: 10px) {',
      '  .sheet {',
      '    color: red;',
      '  }',
      '}',
      '.sheet-tint {',
      '  color: rgb(from red r g b);',
      '}',
      '.sheet-list {',
      '  scrollbar-width: none;',
      '}',
      ''
    ].join('\n');
    const FIXED_CSS =
      '.sheet p {\n  color: red;\n}\n.sheet-tint {\n  color: rgba(255, 0, 0, 0.5);\n}\n';
    /** The template's own component with each of the four planted, or each fixed. */
    const variant = (planted: boolean): Record<string, string> => {
      const scroller = 'class="min-h-0 flex-1 overflow-y-auto p-4"';
      const body = 'class="text-body-large text-on-surface"';
      expect(component, 'the template no longer has the markup this plants into').toContain(
        scroller
      );
      expect(component).toContain(body);
      const text = component
        .replace(
          scroller,
          planted
            ? 'class="planted h-full overflow-y-auto p-4"'
            : 'class="planted min-h-0 flex-1 overflow-y-auto p-4"'
        )
        .replace(body, planted ? 'class="text-body-lagre text-on-surface"' : body);
      const style = planted
        ? '.planted:has(p) {\n    min-height: 100dvh;\n  }'
        : '.planted p {\n    margin: 0;\n  }';
      return {
        'src/index.svelte': `${text}\n<style>\n  ${style}\n</style>\n`,
        // A plain stylesheet beside it: until MICA-312, `postcss-html` was applied to `.css`
        // too, parsed it as HTML, found no `<style>`, and checked nothing in it.
        'src/theme.css': planted ? PLANTED_CSS : FIXED_CSS
      };
    };

    /** A command as its own process, in `dir`, with the copy's `.bin` first on `PATH`. */
    const run = (dir: string, command: string) =>
      new Promise<{ code: number; output: string }>((resolve) => {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV' && !k.startsWith('VITEST'))
        );
        env.PATH = `${path.join(dir, 'node_modules/.bin')}${path.delimiter}${env.PATH ?? ''}`;
        execFile(
          '/bin/sh',
          ['-c', command],
          { cwd: dir, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ code, output: `${stdout}\n${stderr}` });
          }
        );
      });

    const script = (
      JSON.parse(read(path.join(TEMPLATE_DIR, 'package.json'))) as {
        scripts: Record<string, string>;
      }
    ).scripts.check;
    const checks: Record<string, { code: number; output: string }> = {};

    beforeAll(async () => {
      const cases: [string, Record<string, string>, Record<string, string>, string][] = [
        ['clean', {}, CHECK_TOOLCHAIN, script],
        ['planted', variant(true), CHECK_TOOLCHAIN, script],
        ['fixed', variant(false), CHECK_TOOLCHAIN, script],
        // Nothing to read: a directory with no component in it.
        [
          'empty',
          { 'empty/.keep': '' },
          CHECK_TOOLCHAIN,
          `node node_modules/@mica/sdk/${CHECK_CLI} empty`
        ],
        // Installed without the stylelint half: the floor cannot be checked.
        ['no stylelint', {}, {}, `node node_modules/@mica/sdk/${CHECK_CLI} src`]
      ];
      await Promise.all(
        cases.map(async ([name, extra, links, command]) => {
          const dir = copyTemplate(extra, links, links === CHECK_TOOLCHAIN ? CHECK_BIN : {});
          checks[name] = await run(dir, command);
        })
      );
    }, 180_000);

    it('passes the template as shipped, svelte-check and the SDK checker both', () => {
      expect(checks.clean.code, checks.clean.output).toBe(0);
      expect(checks.clean.output).toMatch(/COMPLETED \d+ FILES 0 ERRORS 0 WARNINGS/);
      expect(checks.clean.output).toMatch(/mica check: OK — 2 \.svelte, \d+ \.ts/);
    });

    it.each([
      ['an h-full inside Screen', /^src\/index\.svelte:\d+ mica\/screen-h-full /m],
      [
        'a misspelt utility class',
        /^src\/index\.svelte:\d+ mica\/unknown-class "text-body-lagre" /m
      ],
      [':has()', /^src\/index\.svelte:\d+ plugin\/no-unsupported-browser-features .*"css-has"/m],
      [
        'dvh',
        /^src\/index\.svelte:\d+ plugin\/no-unsupported-browser-features .*"viewport-unit-variants"/m
      ],
      [
        ':has() in a .css file',
        /^src\/theme\.css:1 plugin\/no-unsupported-browser-features .*"css-has"/m
      ],
      [
        'svh in a .css file',
        /^src\/theme\.css:5 plugin\/no-unsupported-browser-features .*"viewport-unit-variants"/m
      ],
      [
        'container query in a .css file',
        /^src\/theme\.css:7 plugin\/no-unsupported-browser-features .*"css-container-queries"/m
      ],
      [
        'rgb(from …) in a .css file, by stylelint',
        /^src\/theme\.css:13 plugin\/no-unsupported-browser-features .*"css-relative-colors"/m
      ],
      [
        'rgb(from …) in a .css file, by the SDK checker',
        /^src\/theme\.css:13 mica\/css-color-floor rgb\(from/m
      ],
      [
        'scrollbar-width in a .css file',
        /^src\/theme\.css:16 plugin\/no-unsupported-browser-features .*"css-scrollbar"/m
      ]
    ])('fails a planted %s, naming the file, the line and the rule', (_label, line) => {
      expect(checks.planted.code, checks.planted.output).toBe(1);
      expect(checks.planted.output).toMatch(line);
    });

    it('reports exactly the ten it was planted with', () => {
      // Four in the component, and six in the stylesheet: relative colour is named twice.
      expect(checks.planted.output).toMatch(
        /mica check: 10 violation\(s\) in 2 \.svelte, \d+ \.ts, 1 \.css/
      );
    });

    it('passes the same file once each is fixed', () => {
      expect(checks.fixed.code, checks.fixed.output).toBe(0);
      expect(checks.fixed.output).toMatch(/mica check: OK/);
    });

    it.each([
      ['finds nothing to check', 'empty', /found no \.svelte file under empty/],
      [
        'cannot load stylelint',
        'no stylelint',
        /stylelint, stylelint-no-unsupported-browser-features, postcss-html not installed/
      ]
    ])('fails loudly, rather than passing, when it %s', (_label, name, reason) => {
      expect(checks[name].code, checks[name].output).toBe(2);
      expect(checks[name].output).toMatch(reason);
    });
  });
});
