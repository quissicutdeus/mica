// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as ts from 'typescript-ast-parser';

/**
 * MICA-165: every place an encrypted column is read or written, held to the cipher.
 *
 * Two halves. The **guard** parses server source for SQL statements that name an encrypted
 * table beside its encrypted column (or `*`), and fails on one in an unlisted file or in a
 * function that neither opens nor seals — the reader added next year that hands a player
 * ciphertext, or a writer that stores plaintext beside it. The **round trips** drive the real services, with a key, through a stubbed
 * database: what a write path hands the database is sealed, and what a read path hands back is
 * the text again.
 *
 * What the scan cannot see: SQL whose table name is not a literal — `${this.tableName}` in a
 * repository, `${table}` in `lib/moderation.ts` and `services/Privacy.ts`. Those read the
 * registry instead of naming a table, and the round trips below are what hold them.
 */
const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import '../services';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { __resetRateLimits } from '../lib/rateLimit';
import {
  UNREADABLE_CONTENT,
  encryptedColumns,
  isSealed,
  maxPlaintextChars,
  openContent,
  contentContext,
  encryptedColumn,
  resetContentCipherForTests,
  sealContent,
  sealedLengthForChars
} from '../lib/contentCipher';
import { declaredServices, resolveAppSchema } from '../lib/defineService';
import { summariseTarget } from '../lib/moderation';
import { messages, sendFromLine } from '../services/Messages';
import { blabberDms } from '../services/BlabberDms';
import { mail, SendSystemEmail } from '../services/Mail';
import { reports } from '../services/Reports';
import { conversations } from '../services/Conversations';
import { buildExport } from '../services/Privacy';
import { MESSAGE_BODY_MAX } from '@mica/shared/contracts/messages';
import { MAIL_CONTENT_MAX } from '@mica/shared/contracts/mail';

const ROOT = join(__dirname, '..', '..');

// ─── the guard ───────────────────────────────────────────────────────────────────────────────

/**
 * The files that may hold SQL naming each encrypted column, as a record of who does. Every such
 * statement in them is then held, one by one, to the function it sits in (see `sealedSql`).
 * A table with no files is still listed: it is encrypted, and nothing names it by literal.
 */
const ALLOWLIST: Record<string, { column: string; files: readonly string[] }> = {
  mica_messages: {
    column: 'message',
    files: [
      'server/repositories/MessageRepository.ts',
      'server/repositories/ConversationRepository.ts',
      'server/lib/seed.ts',
      'server/services/Seed.ts',
      'server/lib/import/write.ts'
    ]
  },
  mica_blabber_dms: { column: 'body', files: ['server/services/BlabberDms.ts'] },
  mica_mail: { column: 'content', files: ['server/services/Mail.ts'] },
  mica_reports: { column: 'target_preview', files: [] }
};

/** The calls that open or seal. The function holding the SQL has to make one. */
const HELPERS: ReadonlySet<string> = new Set([
  'openRows',
  'openRow',
  'openContent',
  'tryOpenContent',
  'sealRow',
  'sealContent',
  'sealContentWith'
]);

/**
 * Whether `node` contains a call to a helper — a real `CallExpression`, read off the AST, so a
 * helper's name in a comment or a string does not count.
 */
const callsHelper = (node: ts.Node): boolean => {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && HELPERS.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });

/**
 * Does one SQL statement's text name `table` together with `column` or a `*`? Escaped backticks
 * are unescaped first, so `` \`mica_mail\` `` reads as the SQL it becomes.
 */
export const namesSealedColumn = (sql: string, table: string, column: string): boolean => {
  const text = sql.replace(/\\`/g, '`');
  const reference = new RegExp(
    `\\b(?:FROM|JOIN|INTO|UPDATE)\\s+\`?${table}\`?(?![A-Za-z0-9_])`,
    'i'
  );
  const touches = new RegExp(
    [
      `\`${column}\``,
      `\\b[a-z]\\.${column}\\b`,
      '\\bSELECT\\s+(?:DISTINCT\\s+)?(?:[a-z]\\.)?\\*',
      '\\b[a-z]\\.\\*',
      `\\([^)]*\\b${column}\\b[^)]*\\)\\s*VALUES`,
      `\\bSELECT\\b[\\s\\S]*\\b${column}\\b[\\s\\S]*\\bFROM\\b`
    ].join('|'),
    'i'
  );
  return reference.test(text) && touches.test(text);
};

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node);

const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/**
 * One SQL statement as the source spells it: a string or template literal, or a chain of them
 * joined by `+`, with each `${…}` or non-literal operand standing in as `${…}`. So a table
 * name that is itself an expression — `${this.tableName}`, `${table}` — is **not seen**: those
 * statements read the registry instead, and the round trips below hold them.
 */
const statementText = (node: ts.Node): string => {
  if (isPlus(node)) return statementText(node.left) + statementText(node.right);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${…}${span.literal.text}`).join('');
  }
  if (ts.isParenthesizedExpression(node)) return statementText(node.expression);
  return '${…}';
};

interface SealedSql {
  table: string;
  file: string;
  line: number;
  /** Whether the nearest enclosing function calls a helper. */
  handled: boolean;
}

/**
 * Every SQL statement in `text` that names an encrypted column, each judged by **the function
 * it sits in**: that function has to call a helper. Per function rather than per file, so a new
 * raw read added beside one that opens is still caught; not per statement, because the open is
 * usually a line or a `map` away from the literal (`ConversationRepository`'s inbox) and telling
 * which call consumes which query would be data flow, not a scan. Two statements in one
 * function where only one is opened pass — the round trips are what cover that.
 */
export const sealedSql = (text: string, file: string): SealedSql[] => {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: SealedSql[] = [];
  const visit = (node: ts.Node): void => {
    const isStatement =
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        isPlus(node)) &&
      !isPlus(node.parent);
    if (isStatement) {
      const sql = statementText(node);
      for (const entry of encryptedColumns()) {
        if (!namesSealedColumn(sql, entry.table, entry.column)) continue;
        let fn: ts.Node | undefined = node.parent;
        while (fn && !isFunctionLike(fn)) fn = fn.parent;
        out.push({
          table: entry.table,
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          handled: callsHelper(fn ?? sourceFile)
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
};

const scan = (): SealedSql[] =>
  walk(join(ROOT, 'server')).flatMap((full) =>
    sealedSql(readFileSync(full, 'utf8'), relative(ROOT, full).split('\\').join('/'))
  );

describe('the encrypted-column guard (MICA-165)', () => {
  it('finds SQL to check, so the rest of this is not vacuous', () => {
    expect(scan().length).toBeGreaterThanOrEqual(8);
  });

  it('knows every encrypted column the services declare, and nothing else', () => {
    const declared = encryptedColumns()
      .map((entry) => `${entry.table}.${entry.column}`)
      .sort();
    const listed = Object.entries(ALLOWLIST)
      .map(([table, { column }]) => `${table}.${column}`)
      .sort();
    expect(declared, 'a column was encrypted or decrypted without this list moving').toEqual(
      listed
    );
  });

  it('declares each column with the scope the owner decided', () => {
    const scopes = Object.fromEntries(
      encryptedColumns().map((entry) => [`${entry.table}.${entry.column}`, entry.scope])
    );
    expect(scopes).toEqual({
      'mica_messages.message': ['conversation_id'],
      'mica_blabber_dms.body': ['from_account', 'to_account'],
      'mica_mail.content': [],
      'mica_reports.target_preview': ['target_table', 'target_id']
    });
  });

  it('refuses SQL over an encrypted column in a file nobody listed', () => {
    const strays = scan()
      .filter(({ table, file }) => !ALLOWLIST[table]?.files.includes(file))
      .map(({ table, file, line }) => `${file}:${line} (${table})`);
    expect(strays, 'open or seal through lib/contentCipher.ts, then list the file here').toEqual(
      []
    );
  });

  it('refuses such SQL in a function that neither opens nor seals', () => {
    const raw = scan()
      .filter(({ handled }) => !handled)
      .map(({ table, file, line }) => `${file}:${line} (${table})`);
    expect(raw, 'the function holding this SQL calls no open or seal helper').toEqual([]);
  });

  it('drops a listed file that no longer names its column', () => {
    const found = scan();
    const stale = Object.entries(ALLOWLIST).flatMap(([table, { files }]) =>
      files
        .filter((file) => !found.some((hit) => hit.table === table && hit.file === file))
        .map((file) => `${file} (${table})`)
    );
    expect(stale).toEqual([]);
  });

  it('reads one statement the way SQL does', () => {
    expect(namesSealedColumn('SELECT * FROM \\`mica_mail\\` WHERE x', 'mica_mail', 'content')).toBe(
      true
    );
    expect(
      namesSealedColumn('SELECT m.message FROM mica_messages m', 'mica_messages', 'message')
    ).toBe(true);
    expect(
      namesSealedColumn('SELECT 1 FROM mica_messages_participants p', 'mica_messages', 'message')
    ).toBe(false);
    expect(
      namesSealedColumn(
        'SELECT m.`id` FROM `mica_messages` m WHERE m.`conversation_id` = ?',
        'mica_messages',
        'message'
      )
    ).toBe(false);
  });

  it('judges each function, not the file: a raw read beside one that opens is caught', () => {
    const source = [
      "import { openRows } from '../lib/contentCipher';",
      'export const opened = async () =>',
      "  openRows('mica_mail', await Database.query('SELECT * FROM `mica_mail` WHERE `id` = ?'));",
      'export const raw = async () => {',
      "  const sql = 'SELECT `content` ' +",
      "    'FROM `mica_mail` WHERE `id` = ?';",
      '  return await Database.query(sql);',
      '};',
      'export const unseen = async (table: string) =>',
      '  await Database.query(`SELECT * FROM `${table}``);'
    ].join('\n');
    expect(sealedSql(source, 'probe.ts').map(({ line, handled }) => [line, handled])).toEqual([
      [3, true],
      [5, false]
    ]);
  });

  it('takes only a real call as opening, never the name in a comment or a string', () => {
    const source = [
      'export const pretends = async () => {',
      '  // openRows( is what this should call',
      "  const note = 'sealContent(';",
      "  return await Database.query('SELECT * FROM `mica_mail`');",
      '};',
      'export const opens = async () =>',
      "  helpers.openRows('mica_mail', await Database.query('SELECT * FROM `mica_mail`'));"
    ].join('\n');
    expect(sealedSql(source, 'probe.ts').map(({ line, handled }) => [line, handled])).toEqual([
      [4, false],
      [7, true]
    ]);
  });
});

// ─── the declarations ────────────────────────────────────────────────────────────────────────

describe('what the declarations mean for size', () => {
  const rule = (service: { resolved: any }, column: string) =>
    service.resolved.columnRules[column].maxLength;
  const stored = (service: { resolved: any }, column: string) =>
    service.resolved.fields.find((f: any) => f.name === column).def;

  it('holds a text body to what fits once sealed, and the contracts agree', () => {
    expect(rule(messages, 'message')).toBe(maxPlaintextChars(65535));
    expect(MESSAGE_BODY_MAX).toBe(maxPlaintextChars(65535));
    expect(rule(mail, 'content')).toBe(maxPlaintextChars(65535));
    expect(MAIL_CONTENT_MAX).toBe(maxPlaintextChars(65535));
  });

  it('keeps a varchar plaintext bound and emits the column as wide as its sealed form', () => {
    expect(rule(blabberDms, 'body')).toBe(500);
    expect(stored(blabberDms, 'body').length).toBe(sealedLengthForChars(500));
    expect(rule(reports, 'target_preview')).toBe(300);
    expect(stored(reports, 'target_preview').length).toBe(sealedLengthForChars(300));
  });

  it('writes those widths into the generated schema', () => {
    const sql = readFileSync(join(ROOT, 'mica.sql'), 'utf8');
    expect(sql).toContain(`\`body\` varchar(${sealedLengthForChars(500)}) NOT NULL`);
    expect(sql).toContain(`\`target_preview\` varchar(${sealedLengthForChars(300)}) DEFAULT NULL`);
  });

  it('matches migration 0007, whose widths are frozen', () => {
    const text = readFileSync(
      join(ROOT, 'server/migrations/0007_sealed_bodies_widen_their_columns.ts'),
      'utf8'
    );
    expect(text).toContain(`width: ${sealedLengthForChars(500)}`);
    expect(text).toContain(`width: ${sealedLengthForChars(300)}`);
  });

  it('registers a declared table exactly once', () => {
    const tables = declaredServices.map((s) => s.table);
    for (const entry of encryptedColumns()) expect(tables).toContain(entry.table);
  });
});

describe('what an encrypted declaration may say', () => {
  const declare = (over: Record<string, unknown>, column: Record<string, unknown> = {}) =>
    resolveAppSchema({
      id: 'sealed_probe',
      access: { read: 'owner', write: 'server' },
      schema: {
        thread_id: { type: 'int', notNull: true },
        body: { type: 'string', length: 100, encrypted: true, ...column }
      },
      encryptionScope: ['thread_id'],
      ...over
    } as any);

  it('resolves the columns and the scope', () => {
    const resolved = declare({});
    expect(resolved.encryptedColumns).toEqual(['body']);
    expect(resolved.encryptionScope).toEqual(['thread_id']);
    expect(resolved.columnRules.body.maxLength).toBe(100);
  });

  it.each([
    ['no encryptionScope', { encryptionScope: undefined }, {}, /no 'encryptionScope'/],
    ['citizenid in the scope', { encryptionScope: ['citizenid'] }, {}, /cannot bind/],
    ['id in the scope', { encryptionScope: ['id'] }, {}, /cannot bind/],
    ['a column that is not there', { encryptionScope: ['nope'] }, {}, /cannot bind/],
    ['the encrypted column itself', { encryptionScope: ['body'] }, {}, /an encrypted column/],
    [
      'a client-writable scope column',
      { access: { read: 'owner', write: 'owner' } },
      { clientWritable: false },
      /a client may rewrite/
    ],
    ['an index', {}, { index: true }, /'index'/],
    ['a filter', {}, { clientFilterable: true }, /'clientFilterable'/],
    ['a default', {}, { default: 'x' }, /'default'/],
    ['an int', {}, { type: 'int' }, /Only text is sealed/],
    ['a varchar too long to seal', {}, { length: 5000 }, /Declare it 'text'/]
  ])('refuses %s', (_label, over, column, message) => {
    expect(() => declare(over, column)).toThrow(message);
  });

  it('refuses a scope with nothing encrypted', () => {
    expect(() =>
      resolveAppSchema({
        id: 'plain_probe',
        schema: { body: 'text' },
        encryptionScope: []
      })
    ).toThrow(/no column is 'encrypted'/);
  });

  it('refuses an encrypted column on a child table, which nothing would open', () => {
    expect(() =>
      declare({
        childTables: [
          { name: 'sealed_probe_notes', columns: { note: { type: 'text', encrypted: true } } }
        ]
      })
    ).toThrow(/child table/);
  });
});

// ─── the round trips ─────────────────────────────────────────────────────────────────────────

const keyDir = mkdtempSync(join(tmpdir(), 'mica-sealed-'));
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));
const keyPath = join(keyDir, 'content.key');
writeFileSync(keyPath, `k1 ${randomBytes(32).toString('base64')}\n`);
chmodSync(keyPath, 0o600);

let withKey = true;
let nextId = 100;
const inserts: { sql: string; params: unknown[] }[] = [];

/** The row an `INSERT INTO t (a, b) VALUES (?, ?)` wrote, by column. */
const rowOf = (sql: string, params: unknown[]): Record<string, unknown> => {
  const list = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')'));
  const columns = list.split(',').map((c) => c.trim().replace(/`/g, ''));
  return Object.fromEntries(columns.map((column, i) => [column, params[i]]));
};
const insertedInto = (table: string) =>
  inserts
    .filter(({ sql }) => new RegExp(`INTO \`?${table}\`? `).test(sql))
    .map(({ sql, params }) => rowOf(sql, params));

/** Per-test answers, tried before the cipher's own bookkeeping. */
let answerQuery: (sql: string, params: unknown[]) => unknown = () => [];
let answerSingle: (sql: string, params: unknown[]) => unknown = () => null;

const player = { current: 'CIT_A' };

const call = async (service: string, action: string, data: unknown, src = 5) => {
  const handler = handlers.get(`mica:server:${service}:${action}`);
  if (!handler) throw new Error(`no handler for ${service}:${action}`);
  (globalThis as any).source = src;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  const replies = (globalThis.emitNet as any).mock.calls.filter((c: unknown[]) =>
    String(c[0]).startsWith('mica:client:')
  );
  return replies.at(-1)?.[3];
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  resetContentCipherForTests();
  withKey = true;
  nextId = 100;
  inserts.length = 0;
  answerQuery = () => [];
  answerSingle = () => null;
  player.current = 'CIT_A';
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_content_key_file' ? (withKey ? keyPath : '') : fallback;
  vi.spyOn(FrameworkBridge, 'getPlayer').mockImplementation(
    () => ({ citizenid: player.current, source: 5, setMeta: () => {} }) as any
  );
  dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes('information_schema.TABLES')) return [{ n: 1 }];
    if (text.includes('information_schema.COLUMNS')) return [{ chars: 65535, bytes: 65535 }];
    if (text.includes('`mica_schema_migrations`'))
      return text.startsWith('SELECT') ? [{ n: 0 }] : {};
    if (text.startsWith('INSERT INTO mica_notifications')) {
      inserts.push({ sql: text, params });
      return {};
    }
    return answerQuery(text, params);
  });
  dbMock.insert.mockImplementation(async (sql: string, params: unknown[] = []) => {
    inserts.push({ sql: String(sql), params });
    nextId += 1;
    return nextId;
  });
  dbMock.single.mockImplementation(async (sql: string, params: unknown[] = []) =>
    answerSingle(String(sql), params)
  );
  dbMock.update.mockResolvedValue(true);
  dbMock.scalar.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Messages (mica_messages.message)', () => {
  it('seals on send and hands the sender and the push the text', async () => {
    answerSingle = (sql) => (sql.includes('mica_messages_participants') ? { 1: 1 } : null);

    const reply = await call('messages', 'send', { conversation_id: 7, message: 'meet me' });

    expect(reply.message).toBe('meet me');
    const [row] = insertedInto('mica_messages');
    expect(isSealed(row.message)).toBe(true);
    expect(String(row.message)).not.toContain('meet me');
  });

  it('opens a thread page, off each row’s own sender and conversation', async () => {
    const sealed = await sealContent(
      { table: 'mica_messages', column: 'message', citizenid: 'CIT_B', scope: [7] },
      'hi there'
    );
    answerSingle = (sql) => (sql.includes('mica_messages_participants') ? { 1: 1 } : null);
    answerQuery = (sql) =>
      sql.includes('FROM mica_messages m')
        ? [{ id: 1, conversation_id: 7, citizenid: 'CIT_B', message: sealed, edited: 0 }]
        : [];

    const reply = await call('messages', 'get', { conversation_id: 7 });

    expect(reply.rows[0].message).toBe('hi there');
  });

  it('shows a padlock for a body copied into another conversation, and keeps the thread', async () => {
    const moved = await sealContent(
      { table: 'mica_messages', column: 'message', citizenid: 'CIT_B', scope: [8] },
      'from elsewhere'
    );
    answerSingle = (sql) => (sql.includes('mica_messages_participants') ? { 1: 1 } : null);
    answerQuery = (sql) =>
      sql.includes('FROM mica_messages m')
        ? [
            { id: 2, conversation_id: 7, citizenid: 'CIT_B', message: 'legacy text', edited: 0 },
            { id: 1, conversation_id: 7, citizenid: 'CIT_B', message: moved, edited: 0 }
          ]
        : [];

    const reply = await call('messages', 'get', { conversation_id: 7 });

    expect(reply.rows.map((r: any) => r.message)).toEqual([UNREADABLE_CONTENT, 'legacy text']);
  });

  it('seals an edit against the row’s own context, read by id', async () => {
    const original = await sealContent(
      { table: 'mica_messages', column: 'message', citizenid: 'CIT_A', scope: [7] },
      'teh plan'
    );
    answerSingle = (sql) => {
      if (sql.includes('mica_messages_participants')) return { 1: 1 };
      if (sql.startsWith('SELECT `citizenid`, `conversation_id`')) {
        return { citizenid: 'CIT_A', conversation_id: 7 };
      }
      if (sql.startsWith('SELECT * FROM `mica_messages`')) {
        return { id: 3, conversation_id: 7, citizenid: 'CIT_A', message: original };
      }
      return null;
    };

    const reply = await call('messages', 'edit', { id: 3, message: 'the plan' });

    expect(reply).toMatchObject({ message: 'the plan', edited: true });
    const [sql, params] = dbMock.update.mock.calls.at(-1)!;
    expect(String(sql)).toMatch(/^UPDATE `mica_messages` SET `message` = \?/);
    const written = params[0] as string;
    expect(isSealed(written)).toBe(true);
    const context = contentContext(encryptedColumn('mica_messages', 'message')!, {
      citizenid: 'CIT_A',
      conversation_id: 7
    });
    expect(openContent(context, written)).toBe('the plan');
  });

  it('refuses a body longer than its sealed form can fit', async () => {
    answerSingle = (sql) => (sql.includes('mica_messages_participants') ? { 1: 1 } : null);

    const reply = await call('messages', 'send', {
      conversation_id: 7,
      message: 'x'.repeat(MESSAGE_BODY_MAX + 1)
    });

    expect(reply.error).toBeTruthy();
    expect(insertedInto('mica_messages')).toEqual([]);
  });

  it('opens the inbox’s last message, off its sender and the conversation', async () => {
    const sealed = await sealContent(
      { table: 'mica_messages', column: 'message', citizenid: 'CIT_B', scope: [9] },
      'see you'
    );
    answerQuery = (sql) =>
      sql.includes('last_message_text')
        ? [
            {
              id: 9,
              updated_at: '2026-09-01 10:00:00',
              last_message_text: sealed,
              last_message_time: '2026-09-01 10:00:00',
              last_message_sender: 'CIT_B'
            }
          ]
        : [];

    const repo = conversations.repo as any;
    const { rows } = await repo.findForPhone('CIT_A', 'phone', { limit: 20, cursor: null });

    expect(rows[0].last_message.message).toBe('see you');
    expect(rows[0].last_message_text).toBe('see you');
  });
});

describe('Blabber DMs (mica_blabber_dms.body)', () => {
  const MINE = { id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };
  const PEER = { id: 2, citizenid: 'CIT_B', handle: 'nightowl', status: 'active' };

  it('seals on send, replies with the text, and persists no copy of it', async () => {
    answerSingle = (sql, params) => {
      if (!sql.includes('mica_accounts')) return null;
      return params.includes(2) ? PEER : MINE;
    };
    answerQuery = (sql) => (sql.includes('mica_accounts') ? [MINE] : []);

    const reply = await call('blabber_dms', 'send', {
      account_id: 1,
      peer_account_id: 2,
      body: 'secret plans'
    });

    expect(reply.body).toBe('secret plans');
    const [row] = insertedInto('mica_blabber_dms');
    expect(isSealed(row.body)).toBe(true);
    await vi.waitFor(() => expect(insertedInto('mica_notifications')).toHaveLength(1));
    const [notification] = insertedInto('mica_notifications');
    expect(notification.body).toBe('');
    expect(JSON.stringify(notification)).not.toContain('secret plans');
  });

  it('opens a thread and the inbox’s last messages', async () => {
    const sealed = await sealContent(
      { table: 'mica_blabber_dms', column: 'body', citizenid: 'CIT_B', scope: [2, 1] },
      'hello ada'
    );
    const row = { id: 5, citizenid: 'CIT_B', from_account: 2, to_account: 1, body: sealed };
    answerSingle = (sql) => (sql.includes('mica_accounts') ? MINE : null);
    answerQuery = (sql) => {
      if (sql.includes('GROUP BY peer')) return [{ peer: 2, last_id: 5 }];
      if (sql.includes('COUNT(*) AS total')) return [];
      if (sql.includes('mica_blabber_dms')) return [row];
      if (sql.includes('mica_accounts')) return [MINE, PEER];
      return [];
    };

    const thread = await call('blabber_dms', 'get', { account_id: 1, peer_account_id: 2 });
    expect(thread.rows[0].body).toBe('hello ada');

    const inbox = await call('blabber_dms', 'threads', undefined);
    expect(inbox[0].last.body).toBe('hello ada');
  });

  it('opens through the generic projection, and drops the context it added', async () => {
    const sealed = await sealContent(
      { table: 'mica_blabber_dms', column: 'body', citizenid: 'CIT_A', scope: [1, 2] },
      'projected'
    );
    answerQuery = (sql) =>
      sql.startsWith('SELECT `body`, `citizenid`, `from_account`, `to_account` FROM')
        ? [{ body: sealed, citizenid: 'CIT_A', from_account: 1, to_account: 2 }]
        : [];

    const rows = await blabberDms.repo.findAll({ citizenid: 'CIT_A' } as any, undefined, ['body']);

    expect(rows).toEqual([{ body: 'projected' }]);
  });
});

describe('Mail (mica_mail.content)', () => {
  it('seals a system email, and the live push carries the text', async () => {
    const sent = await SendSystemEmail('CIT_A', {
      sender: 'Bank',
      subject: 'Statement',
      content: 'balance 12'
    });

    expect(sent?.content).toBe('balance 12');
    const [row] = insertedInto('mica_mail');
    expect(isSealed(row.content)).toBe(true);
  });

  it('opens the inbox', async () => {
    const sealed = await sealContent(
      { table: 'mica_mail', column: 'content', citizenid: 'CIT_A', scope: [] },
      'your statement'
    );
    answerQuery = (sql) =>
      sql.includes('FROM `mica_mail`') ? [{ id: 1, citizenid: 'CIT_A', content: sealed }] : [];

    const inbox = await call('mail', 'getMail', undefined);

    expect(inbox[0].content).toBe('your statement');
  });

  it('refuses a body past what fits sealed, without writing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = await SendSystemEmail('CIT_A', {
      sender: 'Bank',
      subject: 'Long',
      content: 'x'.repeat(MAIL_CONTENT_MAX + 1)
    });

    expect(sent).toBeNull();
    expect(insertedInto('mica_mail')).toEqual([]);
  });
});

describe('Reports (mica_reports.target_preview) and the review queue', () => {
  it('opens a sealed target to preview it, and seals the snapshot under the report', async () => {
    const dm = await sealContent(
      { table: 'mica_blabber_dms', column: 'body', citizenid: 'CIT_B', scope: [2, 1] },
      'you will regret this'
    );
    answerSingle = (sql) =>
      sql.includes('FROM `mica_blabber_dms`')
        ? { citizenid: 'CIT_B', status: 'active', preview: dm, from_account: 2, to_account: 1 }
        : null;
    // The reporter has to be one of the DM's ends to report it (MICA-339): account 1 is theirs.
    answerQuery = (sql) =>
      sql.includes('FROM `mica_accounts`')
        ? [
            { id: 1, citizenid: 'CIT_A', status: 'active' },
            { id: 2, citizenid: 'CIT_B', status: 'active' }
          ]
        : [];

    expect((await summariseTarget('mica_blabber_dms', 5)).preview).toBe('you will regret this');

    await call('reports', 'create', {
      targetTable: 'mica_blabber_dms',
      targetId: 5,
      category: 'threats'
    });
    const [report] = insertedInto('mica_reports');
    expect(isSealed(report.target_preview)).toBe(true);
    const context = contentContext(encryptedColumn('mica_reports', 'target_preview')!, report);
    expect(openContent(context, report.target_preview as string)).toBe('you will regret this');
  });

  it('opens the snapshot for an admin, in the queue and in the history', async () => {
    const preview = await sealContent(
      {
        table: 'mica_reports',
        column: 'target_preview',
        citizenid: 'CIT_A',
        scope: ['mica_blabber_dms', 5]
      },
      'you will regret this'
    );
    const row = {
      id: 1,
      citizenid: 'CIT_A',
      target_table: 'mica_blabber_dms',
      target_id: 5,
      resolution: 'pending',
      target_preview: preview,
      created_at: '2026-09-01 10:00:00',
      updated_at: '2026-09-01 10:00:00'
    };
    answerQuery = (sql) => (sql.includes('`mica_reports`') ? [row] : []);

    const queue = await call('reports', 'queue', undefined, 0);
    expect(queue[0].target_preview).toBe('you will regret this');
    const history = await call('reports', 'history', undefined, 0);
    expect(history[0].target_preview).toBe('you will regret this');
  });
});

describe('the privacy export', () => {
  it('returns a player their own words, not ciphertext, and adds no column', async () => {
    const sealed = await sealContent(
      { table: 'mica_messages', column: 'message', citizenid: 'CIT_A', scope: [7] },
      'my own words'
    );
    answerQuery = (sql) =>
      /FROM `mica_messages` WHERE/.test(sql)
        ? [{ id: 1, conversation_id: 7, message: sealed, citizenid: 'CIT_A' }]
        : [];

    const exported = await buildExport('CIT_A');
    const category = exported.categories.find((c) => c.category === 'messages')!;

    expect(category.rows).toEqual([{ id: 1, conversation_id: 7, message: 'my own words' }]);
  });
});

/**
 * Text that happens to start like a sealed value (Warthog, MICA-165): a player can type
 * `$mc1$…` into any field, and a report copies an unsealed Blab or listing title verbatim. With
 * a key it is sealed like any text and comes back exactly; without one, a write of it is refused
 * with a message the player can read — and a report's snapshot of someone else's post is never
 * refused at all.
 */
describe('text that starts like a sealed value', () => {
  const LOOKALIKE = `$mc1$k1$${'A'.repeat(40)}`;
  const MINE = { id: 1, citizenid: 'CIT_A', app: 'blabber', handle: 'ada', status: 'active' };
  const PEER = { id: 2, citizenid: 'CIT_B', handle: 'nightowl', status: 'active' };
  const blabTarget = (sql: string) =>
    /FROM `mica_blabber` /.test(sql)
      ? { citizenid: 'CIT_B', status: 'active', preview: LOOKALIKE }
      : null;
  const openStored = (table: string, column: string, row: Record<string, unknown>) =>
    openContent(contentContext(encryptedColumn(table, column)!, row), row[column] as string);
  const accountsAndMembers = (sql: string, params: unknown[]) => {
    if (sql.includes('mica_messages_participants')) return { 1: 1 };
    if (sql.includes('mica_accounts')) return params.includes(2) ? PEER : MINE;
    return null;
  };

  it.each([true, false])('files a report on such a Blab, key: %s', async (keyed) => {
    withKey = keyed;
    answerSingle = blabTarget;

    const reply = await call('reports', 'create', { targetTable: 'mica_blabber', targetId: 9 });

    expect(reply).toMatchObject({ ok: true });
    const [report] = insertedInto('mica_reports');
    if (keyed) {
      expect(isSealed(report.target_preview)).toBe(true);
      expect(openStored('mica_reports', 'target_preview', report)).toBe(LOOKALIKE);
    } else {
      // Stored as the plain text it is: the prefix broken by a zero-width space.
      expect(report.target_preview).toBe(`​${LOOKALIKE}`);
      expect(isSealed(report.target_preview)).toBe(false);
    }
  });

  it('seals a message, a DM and a mail that start with it, and opens them exactly', async () => {
    answerSingle = accountsAndMembers;
    answerQuery = (sql) => (sql.includes('mica_accounts') ? [MINE] : []);

    const sent = await call('messages', 'send', { conversation_id: 7, message: LOOKALIKE });
    expect(sent.message).toBe(LOOKALIKE);
    await call('blabber_dms', 'send', { account_id: 1, peer_account_id: 2, body: LOOKALIKE });
    await SendSystemEmail('CIT_A', { sender: 'Bank', subject: 'S', content: LOOKALIKE });

    const rows = [
      ['mica_messages', 'message', insertedInto('mica_messages')[0]],
      ['mica_blabber_dms', 'body', insertedInto('mica_blabber_dms')[0]],
      ['mica_mail', 'content', insertedInto('mica_mail')[0]]
    ] as const;
    for (const [table, column, row] of rows) {
      expect(row[column]).not.toBe(LOOKALIKE);
      expect(openStored(table, column, row)).toBe(LOOKALIKE);
    }
  });

  /**
   * A script relaying words through an export (SendMessage's `sendFromLine`, SendSystemEmail and
   * the qb compat on top of it) is never refused for them: with a key they seal like any text,
   * and without one they are stored with the prefix broken, where a player's own send is refused.
   */
  it.each([true, false])(
    'stores a relayed text and mail with the prefix, key: %s',
    async (keyed) => {
      withKey = keyed;
      answerSingle = (sql) => (sql.includes('mica_messages_conversations') ? { id: 7 } : null);

      const line = await sendFromLine(
        'CIT_A',
        { name: 'Dispatch', number: '555-0100' },
        LOOKALIKE,
        []
      );
      const mailed = await SendSystemEmail('CIT_A', {
        sender: 'Bank',
        subject: 'S',
        content: LOOKALIKE
      });

      expect(line.messageId).toBeGreaterThan(0);
      expect(mailed).not.toBeNull();
      const message = insertedInto('mica_messages')[0];
      const mailRow = insertedInto('mica_mail')[0];
      if (keyed) {
        expect(openStored('mica_messages', 'message', message)).toBe(LOOKALIKE);
        expect(openStored('mica_mail', 'content', mailRow)).toBe(LOOKALIKE);
      } else {
        expect(message.message).toBe(`​${LOOKALIKE}`);
        expect(mailRow.content).toBe(`​${LOOKALIKE}`);
      }
    }
  );

  it('keeps a relayed text at its bound when the prefix break needs the room', async () => {
    withKey = false;
    answerSingle = (sql) => (sql.includes('mica_messages_conversations') ? { id: 7 } : null);
    const atTheLimit = LOOKALIKE + 'x'.repeat(MAIL_CONTENT_MAX - LOOKALIKE.length);

    const mailed = await SendSystemEmail('CIT_A', {
      sender: 'Bank',
      subject: 'S',
      content: atTheLimit
    });

    expect(mailed).not.toBeNull();
    const stored = insertedInto('mica_mail')[0].content as string;
    expect(stored.length).toBe(MAIL_CONTENT_MAX);
    expect(stored).toBe(`​${atTheLimit.slice(0, -1)}`);
  });

  it('refuses a player’s own send of them without a key, readably, and writes nothing', async () => {
    withKey = false;
    answerSingle = accountsAndMembers;
    answerQuery = (sql) => (sql.includes('mica_accounts') ? [MINE] : []);

    const sent = await call('messages', 'send', { conversation_id: 7, message: LOOKALIKE });
    expect(sent.key).toBe('server.content.reservedPrefix');
    const dm = await call('blabber_dms', 'send', {
      account_id: 1,
      peer_account_id: 2,
      body: LOOKALIKE
    });
    expect(dm.key).toBe('server.content.reservedPrefix');

    expect(insertedInto('mica_messages')).toEqual([]);
    expect(insertedInto('mica_blabber_dms')).toEqual([]);
  });
});

describe('without a key', () => {
  it('stores plaintext, as micaOS always has, while nothing was ever sealed', async () => {
    withKey = false;
    answerSingle = (sql) => (sql.includes('mica_messages_participants') ? { 1: 1 } : null);

    await call('messages', 'send', { conversation_id: 7, message: 'plain' });

    expect(insertedInto('mica_messages')[0].message).toBe('plain');
  });
});
