// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Nothing is ever hard deleted (MICA-428). The owner's rule: every row is kept for evidence, and
 * retention, the purges and a player's own deletes are status changes. This holds runtime server
 * code to it.
 *
 * **Every file under `server/` but the tests and the migrations**, as text, comments included,
 * so a statement split across a concatenation, built in a helper or hidden behind a constant
 * still shows its keyword here. A comment that needs the word says "hard delete" in lower case.
 * Fails closed: a file that cannot be read fails, a directory that scans fewer files than
 * `MIN_FILES` fails, and every waiver must still match exactly the hits it names — a stale one
 * fails as loudly as a new statement.
 *
 * Migrations are excepted, each by name below: a migration changes a schema, and dropping a
 * replaced key is how one does. They run once, from `micaschema apply`, never as a player acts.
 */
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');

/** Fewer than this means the walk lost its way, not that the code got smaller. */
const MIN_FILES = 140;

/** What a hard delete looks like, in any case a statement could be written in. */
const RULES: readonly { name: string; pattern: RegExp }[] = [
  // An SQL `DELETE` in any shape, and an HTTP one (`method: 'DELETE'`). Not a foreign key's
  // `ON DELETE` clause, which deletes nothing until something else does.
  { name: 'DELETE', pattern: /(?<!\bON\s{1,8})\bDELETE\b/g },
  // Any case, with any modifier, and the multi-table form: `delete a, b from …`, its aliases
  // plain, quoted or interpolated (`delete ${alias} from`) (MICA-428 review).
  {
    name: 'delete from',
    pattern:
      /\bdelete\s+(?:(?:low_priority|quick|ignore)\s+)*(?:(?:`[^`\n]+`|\$\{[^}\n]+\}|[\w.]+)(?:\s*,\s*(?:`[^`\n]+`|\$\{[^}\n]+\}|[\w.]+))*\s+)?from\b/gi
  },
  /**
   * A REPLACE deletes the row it replaces before writing the new one (MICA-428 review), and
   * `INTO` is optional: `REPLACE t SET`, `REPLACE t VALUES`, `REPLACE t (cols)`. Upper case, any
   * name after it. Any case, `INTO`, or a name a table has — quoted, interpolated or snake_case
   * — then what a statement's next word is. Neither sees `.replace(` or the SQL `REPLACE(`,
   * which change a string, nor "replace these values" in a comment.
   */
  {
    name: 'REPLACE',
    pattern: /\bREPLACE\s+(?:(?:LOW_PRIORITY|DELAYED)\s+)?(?:INTO\s+)?[`$\w]/g
  },
  {
    name: 'replace statement',
    pattern:
      /\breplace\s+(?:(?:low_priority|delayed)\s+)?(?:into\b|(?:`[^`\n]+`|\$\{[^}\n]+\}|\w+[_.]\w+)\s*(?:\(|set\b|values?\b|select\b))/gi
  },
  { name: 'TRUNCATE', pattern: /\bTRUNCATE\b/g },
  { name: 'truncate table', pattern: /\btruncate\s+table\b/gi },
  { name: 'DROP', pattern: /\bDROP\b/g },
  {
    name: 'drop schema object',
    pattern:
      /\bdrop\s+(?:temporary\s+)?(?:table|column|database|schema|index|key|primary|foreign|constraint|view|trigger|procedure|function|partition)\b/gi
  }
];

/**
 * The statements in runtime code that the rules match and that delete no row, each named by file
 * and by the text its statement names, with exactly how many statements it covers. Since
 * MICA-429 gave the last child tables a status, the one left is a constraint drop; a row's
 * delete is never waived (MICA-428).
 */
const WAIVERS: readonly {
  file: string;
  table: string;
  count: number;
  reason: string;
}[] = [
  {
    file: 'server/lib/ownerForeignKeys.ts',
    table: 'FOREIGN KEY',
    count: 1,
    reason:
      'drops the foreign keys onto players (MICA-300) from micaschema apply: a constraint, ' +
      'never a row'
  }
];

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const path = relative(ROOT, full);
    if (path === 'server/__tests__' || path === 'server/migrations') continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (!entry.endsWith('.json')) out.push(full);
  }
  return out;
};

interface Hit {
  file: string;
  line: number;
  rule: string;
  /** The text from the keyword to the end of its statement, near enough to name a table. */
  context: string;
}

const scan = (file: string, text: string): Hit[] => {
  const hits: Hit[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const at = match.index ?? 0;
      hits.push({
        file,
        line: text.slice(0, at).split('\n').length,
        rule: rule.name,
        context: text.slice(at, at + 160)
      });
    }
  }
  return hits;
};

/** One statement can match two rules (`DROP` and `drop … key`); count it once, by position. */
const statements = (hits: readonly Hit[]): Hit[] => {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.file}:${hit.line}:${hit.context.slice(0, 40).toLowerCase()}`;
    const dropKey = `${hit.file}:${hit.line}`;
    if (seen.has(key) || seen.has(dropKey)) return false;
    seen.add(key);
    seen.add(dropKey);
    return true;
  });
};

const scanTree = (): { files: string[]; hits: Hit[] } => {
  const files = walk(SERVER);
  const hits: Hit[] = [];
  for (const full of files) hits.push(...scan(relative(ROOT, full), readFileSync(full, 'utf8')));
  return { files, hits: statements(hits) };
};

/** The tree, walked and scanned once in `beforeAll`, under a generous timeout of its own. */
let tree: { files: string[]; hits: Hit[] } | undefined;
const allHits = (): { files: string[]; hits: Hit[] } => {
  if (!tree) throw new Error('the tree scan has not run: it is computed in beforeAll');
  return tree;
};

describe('no hard deletes in runtime server code (MICA-428)', () => {
  beforeAll(() => {
    tree = scanTree();
  }, 60_000);

  it('scans the whole server tree, so a pass is not an empty walk', () => {
    const { files } = allHits();
    expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);
    expect(files.some((f) => f.endsWith(join('server', 'services', 'Privacy.ts')))).toBe(true);
    expect(files.some((f) => f.includes(join('server', '__tests__')))).toBe(false);
    expect(files.some((f) => f.includes(join('server', 'migrations')))).toBe(false);
  });

  it('finds nothing but the named waivers, each exactly as often as it says', () => {
    const { hits } = allHits();
    const covered = new Map<string, number>();
    const unwaived: string[] = [];
    for (const hit of hits) {
      const waiver = WAIVERS.find((w) => w.file === hit.file && hit.context.includes(w.table));
      if (!waiver) {
        unwaived.push(`${hit.file}:${hit.line} ${hit.rule}: ${hit.context.split('\n')[0]}`);
        continue;
      }
      const key = `${waiver.file} ${waiver.table}`;
      covered.set(key, (covered.get(key) ?? 0) + 1);
    }
    expect(unwaived, 'a hard delete: make it a status change (MICA-428)').toEqual([]);
    for (const waiver of WAIVERS) {
      expect(covered.get(`${waiver.file} ${waiver.table}`) ?? 0, waiver.reason).toBe(waiver.count);
    }
  });

  /**
   * MICA-429 retired the nine waivers on status-less child tables: a follow, a block, a reaction,
   * an ear, a swipe, a match, a photo and a price point are status changes now. What is left
   * deletes no row.
   */
  it('waives no row delete: the one waiver left is a constraint drop', () => {
    expect(WAIVERS.map((w) => `${w.file} ${w.table}`)).toEqual([
      'server/lib/ownerForeignKeys.ts FOREIGN KEY'
    ]);
  });

  it('gives every waiver a reason', () => {
    for (const waiver of WAIVERS) expect(waiver.reason.length).toBeGreaterThan(10);
  });

  /** The rules, held to what they must and must not see, so a pass is not a blind pattern. */
  it('sees every shape a hard delete takes', () => {
    const sees = (text: string) => scan('x.ts', text).length > 0;
    for (const text of [
      'DELETE FROM `mica_notes` WHERE id = ?',
      "'DELETE ' + 'FROM mica_notes'",
      'delete from mica_notes',
      'Delete From mica_notes',
      'DELETE LOW_PRIORITY IGNORE FROM mica_notes',
      'delete n, m from mica_notes n join mica_media m on m.id = n.id',
      'DELETE `n` FROM `mica_notes` `n`',
      'REPLACE INTO `mica_notes` (id) VALUES (1)',
      'replace into mica_notes set id = 1',
      'Replace Low_Priority Into mica_notes',
      'REPLACE mica_notes SET id = 1',
      'REPLACE LOW_PRIORITY `mica_notes` VALUES (1)',
      'replace `mica_notes` (id) values (1)',
      'Replace mica_notes Values (1)',
      'replace ${TABLE} set id = ?',
      'replace mica_notes select * from mica_media',
      'delete ${alias} from ${table} ${alias}',
      'delete `n`, ${m} from mica_notes n join mica_media m on m.id = n.id',
      "fetch(url, { method: 'DELETE' })",
      'TRUNCATE TABLE mica_notes',
      'truncate table mica_notes',
      'DROP TABLE mica_notes',
      'ALTER TABLE t DROP `c`',
      'alter table t drop column c',
      'alter table t drop foreign key fk'
    ]) {
      expect(sees(text), text).toBe(true);
    }
  });

  it('does not see what deletes nothing', () => {
    const sees = (text: string) => scan('x.ts', text).length > 0;
    for (const text of [
      'REFERENCES players(citizenid) ON DELETE CASCADE',
      'ON DELETE ${onDelete}',
      "UPDATE t SET status = 'deleted'",
      'a soft delete, never a hard delete',
      'a truncated ciphertext is a padlock',
      "method: 'delete'",
      'the key is dropped',
      "text.replace(/a/g, 'b')",
      "SELECT REPLACE(`phone`, '-', '') FROM mica_contacts",
      "SELECT REPLACE (`phone`, '-', '') FROM mica_contacts",
      "value.replace (pattern, '')",
      "text.replaceAll('a', 'b')",
      'replace these values with the new ones',
      'replace it (and its key) on the next start',
      "the player's own delete, from the phone"
    ]) {
      expect(sees(text), text).toBe(false);
    }
  });
});
