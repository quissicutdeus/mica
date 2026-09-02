// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

import {
  README_END,
  README_START,
  calVerOf,
  globToRegExp,
  manifestGlobs,
  readmeExcerpt,
  releaseDate,
  stampManifestVersion,
  uncoveredGlobs,
  zipName
  // @ts-expect-error -- a plain .js build script with no types; this suite is not typechecked.
} from '../../scripts/lib/release-zip.js';
// @ts-expect-error -- same.
import { createZip } from '../../scripts/lib/zip.js';

/**
 * What the release zip is made of, checked on every push rather than on `main` alone --
 * the same reason `packRelease.test.ts` exists. `release.yml` is the only place
 * `scripts/pack-resource.js` runs against a real tag, and a release job is the worst place
 * to first learn that README lost its markers or the manifest grew a second `version` line.
 *
 * The packer itself runs as the `pack` gate of `pnpm verify`, on the build that gate just
 * made, so the whole-tree properties (every manifest glob has a file behind it) are held
 * there. This suite holds the pure parts.
 */

const ROOT = resolve(__dirname, '../..');
const TAG = 'v2026.09.02.3';
const VERSION = '2026.09.02.3';
const REPOSITORY = 'https://github.com/quissicutdeus/gphone';

const MANIFEST = `fx_version 'cerulean'
game 'gta5'

author 'quissicutdeus'
version '1.0.0'
license 'AGPL-3.0-or-later'

server_script 'dist/server/**/*.js'
client_script 'dist/client/**/*.js'

ui_page 'dist/web/index.html'

files {
  'dist/web/index.html',
  'dist/web/assets/**/*',
  'dist/web/*.svg',
  -- a comment with an apostrophe, as the real one has: every add-on 404'd
  'dist/web/addons/**/*',
}
`;

describe('the zip is named for the tag', () => {
  it('takes the CalVer without its v', () => {
    expect(calVerOf(TAG)).toBe(VERSION);
    expect(zipName(TAG)).toBe('gphone-2026.09.02.3.zip');
  });

  it('stamps every entry with midnight UTC on the tag date, so a repack is byte-identical', () => {
    expect(releaseDate(TAG).toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it.each(['2026.09.02.3', 'v1.0.0', 'v2026.9.2.3', '', undefined])(
    'refuses %s, which is not the tag release.yml cuts',
    (tag) => {
      expect(() => calVerOf(tag)).toThrow(/CalVer tag/);
    }
  );
});

describe('the manifest the zip carries', () => {
  it("says the release version instead of package.json's placeholder", () => {
    const stamped = stampManifestVersion(MANIFEST, VERSION);

    expect(stamped).toContain(`version '${VERSION}'`);
    expect(stamped).not.toContain("version '1.0.0'");
    // Nothing else moved: the stamp is one line, and every other line is as generated.
    expect(stamped.split('\n').length).toBe(MANIFEST.split('\n').length);
  });

  it('refuses a manifest with no version line, or two, rather than guessing which', () => {
    expect(() => stampManifestVersion(MANIFEST.replace(/^version .*\n/m, ''), VERSION)).toThrow(
      /0 .*version/
    );
    expect(() => stampManifestVersion(`${MANIFEST}version '2'\n`, VERSION)).toThrow(/2 .*version/);
  });
});

describe('the manifest globs the packer checks the zip against', () => {
  it('reads scripts, the ui page and the files block, and ignores the comment', () => {
    expect(manifestGlobs(MANIFEST)).toEqual([
      'dist/server/**/*.js',
      'dist/client/**/*.js',
      'dist/web/index.html',
      'dist/web/index.html',
      'dist/web/assets/**/*',
      'dist/web/*.svg',
      'dist/web/addons/**/*'
    ]);
  });

  it('matches the way FiveM does: ** spans directories, * does not', () => {
    const deep = globToRegExp('dist/web/assets/**/*');
    expect(deep.test('dist/web/assets/index-abc.js')).toBe(true);
    expect(deep.test('dist/web/assets/fonts/roboto.woff2')).toBe(true);
    expect(deep.test('dist/web/index.html')).toBe(false);

    const flat = globToRegExp('dist/web/*.svg');
    expect(flat.test('dist/web/gphone.svg')).toBe(true);
    expect(flat.test('dist/web/assets/gphone.svg')).toBe(false);
    expect(flat.test('dist/web/gphonexsvg')).toBe(false);
  });

  it('names the glob nothing in the zip satisfies, which is a resource that will 404', () => {
    const packed = [
      'dist/server/server.js',
      'dist/client/client.js',
      'dist/web/index.html',
      'dist/web/assets/index-abc.js',
      'dist/web/gphone.svg'
    ];

    expect(uncoveredGlobs(MANIFEST, packed)).toEqual(['dist/web/addons/**/*']);
    expect(uncoveredGlobs(MANIFEST, [...packed, 'dist/web/addons/notes.js'])).toEqual([]);
  });

  it('is the shape the generator writes, so the real manifest parses to the same list', () => {
    // Read from the generator rather than the tree: `fxmanifest.lua` is generated and a
    // clean checkout has none until the barrels run.
    const generator = readFileSync(join(ROOT, 'scripts/generate-barrels.js'), 'utf8');
    const template = /const manifest = `([\s\S]*?)`;/.exec(generator)?.[1] ?? '';

    expect(manifestGlobs(template)).toEqual(manifestGlobs(MANIFEST));
  });
});

describe('the README the zip carries', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('is fenced in the repository README, in order', () => {
    expect(readme.indexOf(README_START)).toBeGreaterThan(-1);
    expect(readme.indexOf(README_END)).toBeGreaterThan(readme.indexOf(README_START));
  });

  it('tells an owner where to unpack, what to import and what to ensure', () => {
    const excerpt = readmeExcerpt(readme, { tag: TAG, repository: REPOSITORY });

    expect(excerpt).toMatch(/^# gPhone 2026\.09\.02\.3\n/);
    expect(excerpt).toContain(`${REPOSITORY}/blob/${TAG}/README.md`);
    expect(excerpt).toContain('gphone.esx.sql');
    expect(excerpt).toContain('ensure gphone');
  });

  it('never tells an owner to run pnpm -- the zip exists so they need not', () => {
    const excerpt = readmeExcerpt(readme, { tag: TAG, repository: REPOSITORY });

    expect(excerpt).not.toMatch(/pnpm (install|build)/);
    expect(excerpt).not.toContain('From source');
  });

  it('refuses a README with the markers missing or reversed', () => {
    expect(() => readmeExcerpt('no markers', { tag: TAG, repository: REPOSITORY })).toThrow(
      /must carry/
    );
    expect(() =>
      readmeExcerpt(`${README_END}\nbody\n${README_START}`, { tag: TAG, repository: REPOSITORY })
    ).toThrow(/must carry/);
    expect(() =>
      readmeExcerpt(`${README_START}\n\n${README_END}`, { tag: TAG, repository: REPOSITORY })
    ).toThrow(/nothing between/);
  });
});

/**
 * A reader just large enough to check the writer: the end record, the central directory,
 * each local header, and the bytes behind it. `unzip -t` would do the same and is not on
 * every machine this suite runs on; a check that skipped where the tool is missing would
 * read as a pass.
 */
const readZip = (zip: Buffer) => {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const directoryOffset = zip.readUInt32LE(end + 16);

  const entries: Array<{ path: string; data: Buffer; method: number; time: number; day: number }> =
    [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const time = zip.readUInt16LE(at + 12);
    const day = zip.readUInt16LE(at + 14);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const localOffset = zip.readUInt32LE(at + 42);
    const path = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength;

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const bodyAt = localOffset + 30 + localNameLength;
    const body = zip.subarray(bodyAt, bodyAt + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    entries.push({ path, data, method, time, day });
  }
  return entries;
};

describe('the zip writer', () => {
  const mtime = new Date(Date.UTC(2026, 8, 2));

  it('round-trips every entry, sorted, with the one timestamp', () => {
    const text = Buffer.from('ensure gphone\n'.repeat(200));
    const zip = createZip(
      [
        { path: 'gphone/fxmanifest.lua', data: text },
        { path: 'gphone/LICENSE', data: 'AGPL' },
        { path: 'gphone/dist/web/index.html', data: Buffer.alloc(0) }
      ],
      { mtime }
    );

    const entries = readZip(zip);
    expect(entries.map((e) => e.path)).toEqual([
      'gphone/LICENSE',
      'gphone/dist/web/index.html',
      'gphone/fxmanifest.lua'
    ]);
    expect(entries[2].data.equals(text)).toBe(true);
    expect(entries[0].data.toString()).toBe('AGPL');
    expect(entries[1].data.length).toBe(0);
    // Repetitive text deflates; four bytes and an empty file are stored as they are.
    expect(entries[2].method).toBe(8);
    expect(entries[0].method).toBe(0);
    expect(entries[1].method).toBe(0);
    // 2026-09-02 00:00:00 in DOS fields: (2026-1980)<<9 | 9<<5 | 2, and midnight.
    expect(entries[0].day).toBe(((2026 - 1980) << 9) | (9 << 5) | 2);
    expect(entries[0].time).toBe(0);
  });

  it('is a function of its input alone', () => {
    const entries = [
      { path: 'b', data: 'two' },
      { path: 'a', data: 'one' }
    ];

    expect(createZip(entries, { mtime }).equals(createZip([...entries].reverse(), { mtime }))).toBe(
      true
    );
  });

  it.each(['/etc/passwd', 'a/../b', 'a\\b', 'a//b', ''])('refuses the path %s', (path) => {
    expect(() => createZip([{ path, data: '' }], { mtime })).toThrow(/zip:/);
  });

  it('refuses a duplicate path and a year DOS cannot carry', () => {
    expect(() =>
      createZip(
        [
          { path: 'a', data: '' },
          { path: 'a', data: '' }
        ],
        { mtime }
      )
    ).toThrow(/duplicate/);
    expect(() => createZip([], { mtime: new Date(Date.UTC(1979, 0, 1)) })).toThrow(/1979/);
  });
});
