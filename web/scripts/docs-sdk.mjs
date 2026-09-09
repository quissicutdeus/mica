#!/usr/bin/env node
/**
 * MICA-125. Builds the public SDK docs site — https://docs.mica.gg/, linked from the
 * README and deployed by `.github/workflows/docs.yml`.
 *
 * ## Why this is a script and not just `typedoc`
 *
 * Two things a bare `typedoc` invocation cannot do, and both of them are the reason this
 * ticket exists.
 *
 * **It cannot stamp the site with a version.** `--name` takes a literal, and the number the
 * site should carry lives in `sdk/version.ts`. The site used to carry none at all, so a
 * reader had no way to tell what surface they were looking at; it silently described
 * whatever had last merged to `main`. `SDK_CONTRACT_VERSION` is read here, from the real
 * declaration, and `--name` is built from it — see the "Which version is this?" section of
 * `typedoc-home.md` for why that number and not `MICA_VERSION` or `package.json`'s.
 *
 * **It cannot tell you it documented the wrong thing.** `web/typedoc.json` pointed at
 * `../sdk/index.ts` alone for as long as the site existed, which is the *shell's* barrel:
 * the site advertised six names an add-on author cannot call and omitted `bootAddOn`, the
 * one function their bundle must. That config was valid, typedoc exited 0, and the pages
 * were wrong. So the entry points are checked against the emitted artifact here rather than
 * assumed from the config — a docs build that quietly stops covering the add-on surface
 * fails this script instead of publishing.
 *
 * ## Two passes
 *
 * Pass 1 emits JSON only (~2s; the conversion is the cheap half) and is what the assertions
 * read — reflection names out of TypeDoc's own model, not substrings of rendered HTML.
 * The divergence between the two barrels is *derived* from that model and appended to the
 * landing page, so the site's own account of what differs cannot drift from what it
 * documents. Pass 2 renders the HTML with that page as its readme.
 *
 * ## On `skipErrorChecking`
 *
 * `web/typedoc.json` used to set it, and it was not a gate being switched off. TypeDoc runs
 * plain `tsc`, which cannot read a `.svelte` file: `sdk/components.ts` re-exported a type
 * declared inside `RecentlyDeleted.svelte`, and `svelte/types`' ambient
 * `declare module '*.svelte'` has no such member, so the docs build failed with TS2614 from
 * MICA-172 on — failing in the fail-open way, because `docs.yml` only fires on `main` and
 * the site kept serving its last successful build. Skipping the error let it build, at the
 * cost of rendering that type as `any`. MICA-189 moved the interface into
 * `sdk/ui/recentlyDeleted.ts`, where all three compilers resolve it, and the flag came out.
 * It stays out: a type-only re-export from a `.svelte` file is the one shape that breaks
 * this pass, and the fix is a `.ts` sibling, not the flag.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(webDir, '..');
const outDir = path.join(webDir, 'docs');
const configPath = path.join(webDir, 'typedoc.json');
const homePath = path.join(webDir, 'typedoc-home.md');

/** Anything this script refuses to publish says why and exits non-zero. */
const fail = (...lines) => {
  for (const line of lines) console.error(`docs:sdk: ${line}`);
  process.exit(1);
};

const typedocBin = path.join(path.dirname(require.resolve('typedoc/package.json')), 'bin/typedoc');

/**
 * The version stamped on every page.
 *
 * Imported rather than pattern-matched out of the file: Node strips the type annotations
 * itself, so this is the value the phone and every add-on actually see. An empty or missing
 * one is a hard stop — an unlabelled site is the state this ticket is closing, and quietly
 * falling back to "unknown" would recreate it.
 */
const readContractVersion = async () => {
  const source = path.join(repoDir, 'sdk/version.ts');
  let module;
  try {
    module = await import(pathToFileURL(source).href);
  } catch (error) {
    fail(
      `could not import ${path.relative(repoDir, source)} to read the contract version.`,
      String(error)
    );
  }
  const version = module.SDK_CONTRACT_VERSION;
  if (typeof version !== 'string' || version.trim() === '') {
    fail(
      `SDK_CONTRACT_VERSION is ${JSON.stringify(version)} in ${path.relative(repoDir, source)}.`,
      'The docs site is stamped with it; it must be a non-empty string.'
    );
  }
  return version.trim();
};

/**
 * TypeDoc names a module for its entry point's path with the common prefix and the extension
 * removed. Every entry point in this repo is a barrel directly under `sdk/`, so that is the
 * basename — and the assertions below check that assumption against the artifact rather than
 * trusting it.
 */
const moduleNameOf = (entryPoint) => path.basename(entryPoint).replace(/\.tsx?$/, '');

const runTypedoc = (args, label) => {
  const result = spawnSync(process.execPath, [typedocBin, ...args], {
    cwd: webDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stderr.write(output);
  if (result.status !== 0) {
    fail(`typedoc exited ${result.status} during the ${label} pass.`);
  }
};

const main = async () => {
  const version = await readContractVersion();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const expected = (config.entryPoints ?? []).map(moduleNameOf).sort();
  // The two barrels are the point of the site. Documenting one and not the other is the
  // state this ticket found — `index.ts` alone, for as long as the site had existed — so
  // it is named here rather than left to the divergence assertions further down, which
  // could only report it as an absence.
  for (const required of ['index', 'addon']) {
    if (!expected.includes(required)) {
      fail(
        `web/typedoc.json does not declare ../sdk/${required}.ts as an entry point.`,
        `Declared: ${expected.join(', ') || '(none)'}.`,
        'Both SDK barrels are documented; neither audience is the only one.'
      );
    }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mica-docs-'));
  const jsonPath = path.join(scratch, 'sdk.json');

  // Pass 1 — the model, for the assertions and for the generated divergence section.
  runTypedoc(['--json', jsonPath, '--logLevel', 'Error'], 'model');
  const project = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const members = new Map(
    (project.children ?? []).map((mod) => [
      mod.name,
      new Set((mod.children ?? []).map((child) => child.name))
    ])
  );
  // An entry point outside the tsconfig's file set does not fail TypeDoc. It warns, then
  // folds that entry point into another module — which is how `addon.ts` produced no module
  // of its own the first time it was added here, quietly leaving the site on the shell
  // barrel it was being moved off. Comparing the emitted set to the declared one catches
  // that without depending on the wording of a warning.
  const emitted = [...members.keys()].sort();
  if (emitted.join(',') !== expected.join(',')) {
    fail(
      `the modules TypeDoc emitted are not the entry points declared.`,
      `declared: ${expected.join(', ')}`,
      `emitted:  ${emitted.join(', ') || '(none)'}`,
      'A missing one is usually an entry point absent from `include` in web/tsconfig.docs.json.'
    );
  }

  const only = (a, b) => [...members.get(a)].filter((name) => !members.get(b).has(name)).sort();
  const shellOnly = only('index', 'addon');
  const addOnOnly = only('addon', 'index');

  // The defect this ticket names, stated as an assertion. `bootAddOn` is the entry point an
  // add-on bundle must call and it exists on `addon.ts` alone; the shell's catalog and
  // trusted-host controls exist on `index.ts` alone, and handing them to an add-on author
  // as callable API is the other half of the same lie.
  if (!addOnOnly.includes('bootAddOn')) {
    fail(
      '`bootAddOn` is not documented as an add-on-only export.',
      'It is the function a `core: false` bundle must call. Check that ../sdk/addon.ts is an entry point.'
    );
  }
  if (shellOnly.length === 0) {
    fail(
      'the two barrels documented identically.',
      'They diverge by design (sdk/publicSurface.test.ts declares it), so one of the entry points is not what it claims to be.'
    );
  }

  const list = (names) => names.map((name) => `\`${name}\``).join(', ');
  const home = [
    fs.readFileSync(homePath, 'utf8').trimEnd(),
    '',
    '## How the two barrels differ',
    '',
    'Derived from this build, not written by hand — if it disagrees with the module',
    'pages beside it, this build is broken.',
    '',
    `- **On \`index\` and not \`addon\`** (${shellOnly.length}): ${list(shellOnly)}. These are the`,
    "  shell's own controls. An add-on that could name its own host as trusted, or",
    '  rewrite the Store catalog URL, is the hole the sandbox exists to close.',
    `- **On \`addon\` and not \`index\`** (${addOnOnly.length}): ${list(addOnOnly)}. The iframe entry`,
    '  point, which has no meaning for an app running in-process.',
    '',
    'Everything else is on both.',
    ''
  ].join('\n');
  const homeGenerated = path.join(scratch, 'home.md');
  fs.writeFileSync(homeGenerated, home);

  // Pass 2 — the site.
  const name = `@mica/sdk (SDK contract v${version})`;
  const footer = `SDK contract v${version} — <code>SDK_CONTRACT_VERSION</code> in <code>sdk/version.ts</code>. Not the phone's build version.`;
  runTypedoc(
    ['--readme', homeGenerated, '--name', name, '--customFooterHtml', footer, '--logLevel', 'Warn'],
    'render'
  );

  // Verify the artifact, not the config. Everything above read TypeDoc's model; these read
  // the pages that actually ship.
  const page = (file) => {
    const full = path.join(outDir, file);
    if (!fs.existsSync(full)) fail(`${file} was not written.`);
    return fs.readFileSync(full, 'utf8');
  };
  for (const mod of expected) page(`modules/${mod}.html`);
  if (!page('modules/addon.html').includes('bootAddOn')) {
    fail('the rendered addon module page does not mention `bootAddOn`.');
  }
  if (page('modules/index.html').includes('bootAddOn')) {
    fail('the rendered index module page mentions `bootAddOn`, which is not on the shell barrel.');
  }
  if (!page('index.html').includes(`SDK contract v${version}`)) {
    fail(`the rendered landing page is not stamped "SDK contract v${version}".`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(
    `docs:sdk: ${emitted.length} modules (${emitted.join(', ')}) at SDK contract v${version} -> ${path.relative(repoDir, outDir)}`
  );
};

await main();
