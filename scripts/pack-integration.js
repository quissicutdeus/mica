// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { RESOURCE_NAME, calVerFromGit, calVerOf, releaseDate, zipName } from './lib/release-zip.js';
import { createZip } from './lib/zip.js';

/**
 * Pack the integration run's zip (MICA-302): `mica/` exactly as `pack-resource.js` lays it
 * out, plus `mica-integration/`, which the box's `smoke-release.sh` unpacks and the root
 * wrapper reads as "run the suite" when the directory is there.
 *
 * ## Where it lands, and why not beside the release zip
 *
 * `dist/integration/mica-integration-run.zip`. `release.yml` attaches, checksums and
 * attests `dist/release/*.zip`, and its smoke step takes `dist/release/mica-*.zip`; a test
 * harness in that directory would be published to owners as a release asset.
 *
 * ## The `mica/` half is the release packer's own output
 *
 * This runs `pack-resource.js` for the same tag and reads the zip it wrote, rather than
 * assembling the resource a second way. The suite then runs against the bytes a release
 * would ship, and a change to what the resource contains cannot leave the two zips
 * disagreeing. Packing is reproducible, so repeating it in the release job changes nothing.
 *
 *   node scripts/pack-integration.js v2026.09.02.3   the tag release.yml computed
 *   node scripts/pack-integration.js                 the CalVer of HEAD, for a local pack
 */

const OUT = 'dist/integration';
const OUT_NAME = 'mica-integration-run.zip';
const INTEGRATION_NAME = 'mica-integration';
const INTEGRATION_DIR = join('dist/integration', INTEGRATION_NAME);

/** What the wrapper and the box script look for, and the suite cannot start without. */
const REQUIRED_MICA = ['fxmanifest.lua', 'mica.esx.sql'];
const REQUIRED_INTEGRATION = ['fxmanifest.lua', 'server.js', 'expected-scenarios.txt'];

/** Where the suite's scenarios are declared, one `id: '<kebab-case>'` each. */
const SCENARIOS_DIR = 'integration/scenarios';
const SCENARIO_ID = /^\s*id:\s*'([a-z0-9][a-z0-9-]*)'/gm;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Read a zip back into `{ path, data }` entries. Only what `scripts/lib/zip.js` writes --
 * stored or deflated, no ZIP64, no encryption -- and anything else is refused rather than
 * misread. The central directory is the source of truth for sizes, as it is for every
 * extractor.
 *
 * @param {Buffer} buffer
 * @returns {Array<{ path: string, data: Buffer }>}
 */
export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record; not a zip');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL) throw new Error('zip: bad central directory');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(local) !== LOCAL) throw new Error(`zip: bad local header for ${path}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: ${path} uses compression method ${method}`);
    if (data.length !== size) throw new Error(`zip: ${path} is ${data.length} bytes, not ${size}`);
    entries.push({ path, data });
  }
  return entries;
}

/**
 * The entries of the run zip, or an Error naming what is wrong with them.
 *
 * @param {Array<{ path: string, data: Buffer }>} micaEntries what pack-resource packed
 * @param {Array<{ path: string, data: Buffer }>} integrationEntries the built suite, at
 *   paths relative to the resource (`server.js`, not `mica-integration/server.js`)
 */
export function assembleRunEntries(micaEntries, integrationEntries) {
  const strays = micaEntries.filter(({ path }) => !path.startsWith(`${RESOURCE_NAME}/`));
  if (strays.length > 0) {
    throw new Error(
      `the release zip holds entries outside ${RESOURCE_NAME}/: ${strays.map((e) => e.path).join(', ')}`
    );
  }
  const present = new Set(micaEntries.map(({ path }) => path));
  const lacking = REQUIRED_MICA.filter((file) => !present.has(`${RESOURCE_NAME}/${file}`));
  if (lacking.length > 0) {
    throw new Error(
      `the release zip has no ${lacking.map((f) => `${RESOURCE_NAME}/${f}`).join(', ')}`
    );
  }
  if ([...present].some((path) => path.split('/').includes(INTEGRATION_NAME))) {
    throw new Error(`the release zip already holds ${INTEGRATION_NAME}; refusing to merge into it`);
  }
  const havePaths = new Set(integrationEntries.map(({ path }) => path));
  const missing = REQUIRED_INTEGRATION.filter((file) => !havePaths.has(file));
  if (missing.length > 0) {
    throw new Error(
      `the built suite has no ${missing.join(', ')}; run \`pnpm build:integration\` first`
    );
  }
  return [
    ...micaEntries,
    ...integrationEntries.map(({ path, data }) => ({ path: `${INTEGRATION_NAME}/${path}`, data }))
  ];
}

/**
 * The scenario ids declared in the suite's source, which the zip carries as
 * `mica-integration/expected-scenarios.txt` and the box's wrapper holds the run to: exactly
 * those, no more and no fewer. The done line's own count is only as good as what the suite
 * decided to run, and a scenario group dropped from `scenarios/index.ts` would still print a
 * clean `done` with a smaller number. Counting the declarations, which the index cannot
 * drop, is what makes that visible.
 *
 * @param {Array<{ name: string, text: string }>} files the scenario source files
 * @returns {string[]} sorted ids; throws on none or on a duplicate
 */
export function scenarioIds(files) {
  const ids = [];
  for (const { name, text } of files) {
    if (name === 'index.ts') continue;
    for (const match of text.matchAll(SCENARIO_ID)) ids.push(match[1]);
  }
  if (ids.length === 0) {
    throw new Error(`no scenario ids found under ${SCENARIOS_DIR}; a suite of none is not a suite`);
  }
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`scenario id ${duplicate} is declared twice`);
  return ids.sort();
}

const walk = (dir) => {
  let out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
};

const fail = (message) => {
  console.error(`pack-integration: ${message}`);
  process.exit(1);
};

const main = () => {
  const tag = process.argv[2] ?? `v${calVerFromGit()}`;
  try {
    calVerOf(tag);
  } catch (error) {
    fail(error.message);
  }

  if (!existsSync(INTEGRATION_DIR)) {
    fail(
      `no ${INTEGRATION_DIR}. Run \`pnpm build:integration\` (or \`pnpm build:nocheck\`) first; ` +
        'this archives what the build produced and never builds on its own.'
    );
  }

  // The resource half is the release packer's own output, for this tag. It refuses a missing
  // build itself, and an exit from it is this script's exit.
  try {
    execFileSync(process.execPath, ['scripts/pack-resource.js', tag], { stdio: 'inherit' });
  } catch {
    fail('scripts/pack-resource.js failed, so there is no resource to put the suite beside');
  }

  let entries;
  try {
    const micaEntries = readZip(readFileSync(join('dist/release', zipName(tag))));
    const integrationEntries = walk(INTEGRATION_DIR).map((file) => ({
      path: relative(INTEGRATION_DIR, file).split('\\').join(posix.sep),
      data: readFileSync(file)
    }));
    const ids = scenarioIds(
      readdirSync(SCENARIOS_DIR)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => ({ name, text: readFileSync(join(SCENARIOS_DIR, name), 'utf8') }))
    );
    integrationEntries.push({
      path: 'expected-scenarios.txt',
      data: Buffer.from(`${ids.join('\n')}\n`)
    });
    entries = assembleRunEntries(micaEntries, integrationEntries);
  } catch (error) {
    fail(error.message);
  }

  const zip = createZip(entries, { mtime: releaseDate(tag) });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, OUT_NAME), zip);
  console.log(
    `pack-integration: ${OUT_NAME} (${entries.length} files, ${Math.round(zip.length / 1024)} KB) -> ${OUT}/${OUT_NAME}`
  );
};

// Importable by the test without packing anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
