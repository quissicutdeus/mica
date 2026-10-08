// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publicAddonCatalogUrl } from '../../shared/addonConfig';
import { SDK_CONTRACT_VERSION } from '../../sdk/version';
import {
  publicAddonIds,
  publicCatalogPath,
  writePublicCatalog
} from '../../scripts/lib/public-catalog.js';

/**
 * The public add-on catalog (MICA-237): the file a stock server's Store fetches.
 *
 * What nothing else can prove is that the file the image ships is the file the default URL
 * names. The server's default and this generator are two halves that never meet at runtime,
 * so a catalog written one directory off is an empty Store on every stock server and a green
 * build everywhere. These tests hold the path to the URL, and the list to the rule.
 */

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mica-public-catalog-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('where the public catalog is written', () => {
  it('is the path the default catalog URL names', () => {
    const url = publicAddonCatalogUrl(SDK_CONTRACT_VERSION);
    expect(publicCatalogPath(url)).toBe(`addons/sdk-${SDK_CONTRACT_VERSION}/catalog.json`);
  });

  it('follows the contract version, not a fixed directory', () => {
    expect(publicCatalogPath(publicAddonCatalogUrl('7'))).toBe('addons/sdk-7/catalog.json');
  });

  it.each([
    ['a plain-http URL', 'http://mica.gg/addons/sdk-1/catalog.json'],
    ['a URL outside /addons/', 'https://mica.gg/demo/addons/catalog.json'],
    ['a file that is not catalog.json', 'https://mica.gg/addons/sdk-1/other.json'],
    ['a URL that is not a URL', 'addons/sdk-1/catalog.json']
  ])('refuses %s, which nothing would serve', (_name, url) => {
    expect(() => publicCatalogPath(url)).toThrow();
  });
});

describe('which add-ons the public catalog lists', () => {
  it('lists none the resource ships', () => {
    expect(publicAddonIds(['notes', 'snek'], () => true)).toEqual([]);
  });

  it('lists exactly the ones the resource lacks a bundle for', () => {
    expect(publicAddonIds(['notes', 'snek', 'hodlr'], (id: string) => id === 'notes')).toEqual([
      'snek',
      'hodlr'
    ]);
  });
});

describe('writePublicCatalog', () => {
  const url = publicAddonCatalogUrl(SDK_CONTRACT_VERSION);

  const bundles = (ids: string[]): string => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    for (const id of ids) writeFileSync(join(dir, `${id}.js`), 'export {}');
    return dir;
  };

  it('writes a real empty array where the URL says, when every add-on ships', () => {
    const site = scratch();
    const written = writePublicCatalog({
      siteDir: site,
      catalogUrl: url,
      ids: ['notes', 'snek'],
      bundleDir: bundles(['notes', 'snek'])
    });

    expect(written).toBe(join(site, `addons/sdk-${SDK_CONTRACT_VERSION}/catalog.json`));
    expect(JSON.parse(readFileSync(written, 'utf8'))).toEqual([]);
  });

  it('refuses rather than list an add-on whose bundle would be hosted nowhere', () => {
    const site = scratch();
    expect(() =>
      writePublicCatalog({
        siteDir: site,
        catalogUrl: url,
        ids: ['notes', 'snek'],
        bundleDir: bundles(['notes'])
      })
    ).toThrow(/snek.*no bundle/s);
  });
});
