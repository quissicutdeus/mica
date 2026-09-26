// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { format, resolveConfig } from 'prettier';

/**
 * README's "coming from lb-phone" and "coming from NPWD" tables, written from the bridges'
 * own `map.js` (MICA-232), so the table an owner reads is the table the bridge registers.
 * Kept apart from `scripts/bridge-table.js` so `server/__tests__/bridges.test.ts` can hold it.
 */

/** The bridges under `bridges/`, each a resource named for what it answers to. */
export const BRIDGES = ['lb-phone', 'npwd'];

/** What README calls each one in its column header. */
const TITLES = { 'lb-phone': 'lb-phone', npwd: 'NPWD' };

export const startMarker = (bridge) => `<!-- bridge:${bridge}:start -->`;
export const endMarker = (bridge) => `<!-- bridge:${bridge}:end -->`;

/**
 * Run `map.js` the way FiveM does -- a plain script in a fresh context -- and take the table
 * it leaves on `globalThis`. Not `import`: the file is not a module, because FiveM's client
 * runtime has no module loader.
 */
export function loadBridge(root, bridge) {
  const context = createContext({});
  runInContext(readFileSync(join(root, 'bridges', bridge, 'map.js'), 'utf8'), context, {
    filename: `bridges/${bridge}/map.js`
  });
  const table = context.micaBridge;
  if (!table || !Array.isArray(table.entries)) {
    throw new Error(`bridges/${bridge}/map.js left no micaBridge table on globalThis.`);
  }
  return table;
}

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
const code = (name) => `\`${name}\``;

/** The markdown table, unformatted. Server rows first, then client, each in table order. */
export function renderTable(bridge, table) {
  const rows = ['server', 'client'].flatMap((side) =>
    table.entries
      .filter((entry) => entry.side === side)
      .map((entry) => {
        const target =
          entry.uses.length === 0 ? 'none -- logs once' : entry.uses.map(code).join(', ');
        return `| ${code(entry.name)} | ${side} | ${cell(target)} | ${cell(entry.note)} |`;
      })
  );
  return [
    `| ${TITLES[bridge]} export | Side | micaOS | Notes |`,
    '| --- | --- | --- | --- |',
    ...rows
  ].join('\n');
}

/**
 * The fenced region for one bridge, run through Prettier with README's own options so
 * `pnpm format:check` and this agree about every byte.
 */
export async function renderRegion(root, bridge) {
  const readmePath = join(root, 'README.md');
  const options = (await resolveConfig(readmePath)) ?? {};
  const table = await format(renderTable(bridge, loadBridge(root, bridge)), {
    ...options,
    filepath: readmePath
  });
  return `${startMarker(bridge)}\n\n${table.trim()}\n\n${endMarker(bridge)}`;
}

/**
 * README with every bridge's region rewritten. Throws naming the bridge when a marker is
 * missing or out of order: a check that passes because it found nothing to check is the
 * failure this exists to prevent.
 */
export async function rewriteReadme(root, readme) {
  let out = readme;
  for (const bridge of BRIDGES) {
    const start = out.indexOf(startMarker(bridge));
    const end = out.indexOf(endMarker(bridge));
    if (start === -1 || end === -1 || end < start) {
      throw new Error(
        `README.md must carry ${startMarker(bridge)} before ${endMarker(bridge)}; the ` +
          `${TITLES[bridge]} table is generated between them.`
      );
    }
    const region = await renderRegion(root, bridge);
    out = out.slice(0, start) + region + out.slice(end + endMarker(bridge).length);
  }
  return out;
}
