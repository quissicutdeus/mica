// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The frozen add-on's bytes move only on the owner's explicit go-ahead (MICA-462).
 *
 * `web/e2e/fixtures/frozen-addon/frozenprobe.js` stands in for an add-on somebody outside
 * this repo already published: built once against SDK contract version 1, committed, and
 * booted by `web/e2e/frozen-addon.spec.ts` on every run. It guards the wire format only while
 * it stays the bytes that were built then. A fixture that is quietly rebuilt whenever the
 * shell's side changes keeps the suite green and guards nothing, so this pins its hash.
 *
 * **Read by path, not built.** The point is that nothing here regenerates it. The expected
 * hash is a literal, not a snapshot (`vitest -u` rewrites those silently) and not a value
 * read from `entry.json`, which a refresh would rewrite in the same commit.
 */
const DIR = path.resolve(import.meta.dirname, '../../e2e/fixtures/frozen-addon');
const PINNED = 'cd1f4a28d2332c4cc2700cb4cd8db133e35d2b15b57d268d84082b3c62b5113e';

const sha256 = (file: string): string =>
  createHash('sha256')
    .update(fs.readFileSync(path.join(DIR, file)))
    .digest('hex');

describe('the frozen add-on fixture', () => {
  it('is the bytes that were built against contract version 1', () => {
    expect(
      sha256('frozenprobe.js'),
      'web/e2e/fixtures/frozen-addon/frozenprobe.js has changed. It stands in for an add-on ' +
        'already published by somebody outside this repo, so it is never rebuilt to make the ' +
        'suite pass: a shell change that breaks it has broken every add-on out there. ' +
        'Replacing it is the owner’s decision, like the contract version (sdk/version.test.ts). ' +
        'If a change seems to call for it, restore the file and return it to the lead as a ' +
        'finding; do not edit this test to match. The owner’s own refresh follows RECIPE.md ' +
        'and edits the pinned hash here and the sha256 in entry.json in the same commit.'
    ).toBe(PINNED);
  });

  it('is the bundle its catalog entry describes', () => {
    const entry = JSON.parse(fs.readFileSync(path.join(DIR, 'entry.json'), 'utf8')) as {
      id: string;
      sha256: string;
      sdkContract: string;
    };
    expect(entry.id).toBe('frozenprobe');
    expect(entry.sdkContract).toBe('1');
    expect(entry.sha256).toBe(sha256('frozenprobe.js'));
  });
});
