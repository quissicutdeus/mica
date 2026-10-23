// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
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
import { TEST_PHONE_ID } from './phoneStub';
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
import { directMessages } from '../services/DirectMessages';
import { mail, SendSystemEmail } from '../services/Mail';
import { reports } from '../services/Reports';
import { conversations } from '../services/Conversations';
import { buildExport } from '../services/Privacy';
import { withoutOwnerKeys } from '../lib/replyShape';
import { notes } from '../services/Notes';
import { NOTE_CONTENT_MAX, NOTE_TITLE_MAX } from '../../web/src/apps/notes/limits';
import { media } from '../services/Media';
import { blabber } from '../services/Blabber';
import { getNotificationsRepository } from '../services/Notifications';
import { places } from '../services/Places';
import { invoices } from '../services/Invoices';
import { liveChannelByCode } from '../services/Darkchat';
import { MESSAGE_BODY_MAX } from '@mica/shared/contracts/messages';
import { MAIL_CONTENT_MAX } from '@mica/shared/contracts/mail';
import { versionedWrites, type VersionedCall } from './versionedWrites';

/** The versioned writes this test made (MICA-430). */
let versionCalls: VersionedCall[] = [];

const ROOT = join(__dirname, '..', '..');

// ─── the guard ───────────────────────────────────────────────────────────────────────────────

/**
 * The files that may hold SQL naming each encrypted column, as a record of who does. Every such
 * statement in them is then held, one by one, to the function it sits in (see `sealedSql`).
 * A table with no files is still listed: it is encrypted, and nothing names it by literal.
 */
const ALLOWLIST: Record<string, readonly string[]> = {
  'mica_messages.message': [
    'server/repositories/MessageRepository.ts',
    'server/repositories/ConversationRepository.ts',
    'server/lib/seed.ts',
    'server/services/Seed.ts',
    'server/lib/import/write.ts',
    'integration/scenarios/crypto.ts',
    'integration/scenarios/exports.ts',
    'integration/scenarios/importer.ts',
    'integration/scenarios/messages.ts',
    'integration/scenarios/retention.ts'
  ],
  'mica_blabber_dms.body': ['server/services/DirectMessages.ts'],
  'mica_darkchat_messages.body': [
    'server/services/DarkchatMessages.ts',
    'integration/scenarios/darkchat.ts'
  ],
  'mica_darkchat_messages.bot_alias': [
    'server/services/DarkchatMessages.ts',
    'integration/scenarios/darkchat.ts'
  ],
  'mica_mail.content': ['server/services/Mail.ts', 'integration/scenarios/crypto.ts'],
  'mica_reports.target_preview': [],
  'mica_reports.note': [],
  // MICA-431: the phone's own private content, bound to the phone.
  'mica_notes.title': ['integration/scenarios/retention.ts'],
  'mica_notes.content': ['integration/scenarios/retention.ts'],
  'mica_contacts.firstname': [
    'server/lib/import/write.ts',
    'server/lib/seed.ts',
    'integration/scenarios/importer.ts',
    'integration/scenarios/retention.ts'
  ],
  'mica_contacts.lastname': ['server/lib/import/write.ts', 'server/lib/seed.ts'],
  'mica_contacts.email': [],
  'mica_phone_call_log.number': [],
  'mica_places.name': [],
  'mica_places.street_label': [],
  // The five joins open the photo off its own phone (`lib/media/joined.ts`).
  'mica_media.data': [
    'server/lib/import/write.ts',
    'server/repositories/BlabberRepository.ts',
    'server/repositories/GlimpseRepository.ts',
    'server/repositories/MarketplaceRepository.ts',
    'server/repositories/MessageRepository.ts',
    'server/services/Spark.ts',
    'integration/scenarios/http.ts'
  ],
  'mica_media.thumbnail': [
    'server/repositories/BlabberRepository.ts',
    'server/repositories/GlimpseRepository.ts',
    'server/repositories/MarketplaceRepository.ts',
    'server/repositories/MessageRepository.ts',
    'server/services/Spark.ts'
  ],
  'mica_media.alt_text': [
    'server/repositories/BlabberRepository.ts',
    'server/repositories/GlimpseRepository.ts',
    'server/repositories/MarketplaceRepository.ts',
    'server/repositories/MessageRepository.ts',
    'server/services/Spark.ts'
  ],
  'mica_notifications.title': [
    'server/services/Notifications.ts',
    'integration/scenarios/dms.ts',
    'integration/scenarios/glimpse.ts'
  ],
  'mica_notifications.body': [
    'server/services/Notifications.ts',
    'integration/scenarios/addonService.ts',
    'integration/scenarios/dms.ts',
    'integration/scenarios/glimpse.ts'
  ],
  // MICA-432.
  'mica_contacts.phone': [
    'server/lib/import/write.ts',
    'server/lib/seed.ts',
    'server/services/Contacts.ts',
    'integration/scenarios/importer.ts',
    'integration/scenarios/retention.ts'
  ],
  'mica_contacts.avatar': [],
  'mica_darkchat.name': ['server/services/Darkchat.ts', 'integration/scenarios/darkchat.ts'],
  'mica_darkchat.code': ['server/services/Darkchat.ts', 'integration/scenarios/darkchat.ts'],
  'mica_darkchat_members.alias': [
    'server/services/Darkchat.ts',
    'server/services/DarkchatMessages.ts',
    'integration/scenarios/darkchat.ts'
  ],
  'mica_darkchat_members.handle': [
    'server/services/Darkchat.ts',
    'server/services/DarkchatMessages.ts',
    'integration/scenarios/darkchat.ts'
  ],
  'mica_invoices.from_label': ['integration/scenarios/exports.ts'],
  'mica_invoices.memo': ['integration/scenarios/exports.ts'],
  'mica_mail.sender': ['server/services/Mail.ts', 'integration/scenarios/crypto.ts'],
  'mica_mail.sender_address': ['server/services/Mail.ts'],
  'mica_mail.subject': ['server/services/Mail.ts', 'integration/scenarios/crypto.ts'],
  'mica_messages_conversations.name': [
    'server/repositories/ConversationRepository.ts',
    'server/lib/seed.ts',
    'server/lib/import/write.ts'
  ],
  'mica_places.position': []
};

/**
 * In-server scenarios that touch an encrypted column raw **on purpose**, by file and column,
 * never by line: each plants a plaintext row the way a database from before a key holds one,
 * and either reads it back raw to prove nothing sealed it yet or lets a purge delete it unread.
 * micaOS opens plaintext unchanged, so neither is a sealed value read as text. Anything else in
 * `integration/` goes through `integration/lib/sealed.ts`.
 */
const RAW_ON_PURPOSE: Record<string, readonly string[]> = {
  // A mail body stored before a key: `micacrypt status` must leave it, `backfill` seal it.
  'integration/scenarios/crypto.ts': ['mica_mail.content', 'mica_mail.sender', 'mica_mail.subject'],
  // Fixture rows for retention and the character purge, written plain and deleted unread.
  'integration/scenarios/retention.ts': [
    'mica_messages.message',
    'mica_notes.title',
    'mica_notes.content',
    'mica_contacts.firstname',
    'mica_contacts.phone'
  ]
};

/** The calls that open or seal. The function holding the SQL has to make one. */
const HELPERS: ReadonlySet<string> = new Set([
  'openRows',
  'openRow',
  'openContent',
  'tryOpenContent',
  'sealRow',
  'sealContent',
  'sealContentWith',
  // The in-server suite's own reader (`integration/lib/sealed.ts`).
  'openSealed'
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
  /** `table.column`, the allowlist's key. */
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
          table: `${entry.table}.${entry.column}`,
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

/**
 * `server/`, and `integration/` (MICA-431): the in-server suite reads the database as it is, and
 * on hoth a content key is loaded, so a scenario asserting on a sealed column raw fails there
 * and nowhere else. It opens through its own reader, `integration/lib/sealed.ts`.
 */
/**
 * One `[line, handled]` per statement: a statement naming a table with several sealed columns
 * (Mail's four since MICA-432) is reported once per column, and the probes ask about the
 * statement.
 */
const byStatement = (found: SealedSql[]): [number, boolean][] => [
  ...new Map(found.map(({ line, handled }) => [line, handled])).entries()
];

const scanTree = (): SealedSql[] =>
  ['server', 'integration'].flatMap((dir) =>
    walk(join(ROOT, dir)).flatMap((full) =>
      sealedSql(readFileSync(full, 'utf8'), relative(ROOT, full).split('\\').join('/'))
    )
  );

/**
 * The tree is parsed once, in `beforeAll`, and every test below reads that one result. Each
 * test used to walk and parse `server/` and `integration/` itself, a second or more apiece
 * here and three to six on CI, where the first one met vitest's five-second default. The
 * timeout is the scan's own, generous, so a slower runner is a slower run and not a failure.
 */
const SCAN_TIMEOUT_MS = 60_000;
let scanned: SealedSql[] | undefined;
const scan = (): SealedSql[] => {
  if (!scanned) throw new Error('the tree scan has not run: it is computed in beforeAll');
  return scanned;
};

describe('the encrypted-column guard (MICA-165)', () => {
  beforeAll(() => {
    scanned = scanTree();
  }, SCAN_TIMEOUT_MS);

  it('finds SQL to check, so the rest of this is not vacuous', () => {
    expect(scan().length).toBeGreaterThanOrEqual(8);
  });

  it('knows every encrypted column the services declare, and nothing else', () => {
    const declared = encryptedColumns()
      .map((entry) => `${entry.table}.${entry.column}`)
      .sort();
    const listed = Object.keys(ALLOWLIST).sort();
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
      'mica_darkchat_messages.body': ['channel_id'],
      'mica_darkchat_messages.bot_alias': ['channel_id'],
      'mica_mail.content': [],
      'mica_reports.target_preview': ['target_table', 'target_id'],
      // MICA-432.
      'mica_contacts.phone': [],
      'mica_contacts.avatar': [],
      'mica_darkchat.name': [],
      'mica_darkchat.code': [],
      'mica_darkchat_members.alias': ['channel_id'],
      'mica_darkchat_members.handle': ['channel_id'],
      'mica_invoices.from_label': [],
      'mica_invoices.memo': [],
      'mica_mail.sender': [],
      'mica_mail.sender_address': [],
      'mica_mail.subject': [],
      'mica_messages_conversations.name': [],
      'mica_places.position': [],
      'mica_reports.note': ['target_table', 'target_id'],
      'mica_notes.title': [],
      'mica_notes.content': [],
      'mica_contacts.firstname': [],
      'mica_contacts.lastname': [],
      'mica_contacts.email': [],
      'mica_phone_call_log.number': [],
      'mica_places.name': [],
      'mica_places.street_label': [],
      'mica_media.data': [],
      'mica_media.thumbnail': [],
      'mica_media.alt_text': [],
      'mica_notifications.title': [],
      'mica_notifications.body': []
    });
  });

  it('refuses SQL over an encrypted column in a file nobody listed', () => {
    const strays = scan()
      .filter(({ table, file }) => !ALLOWLIST[table]?.includes(file))
      .map(({ table, file, line }) => `${file}:${line} (${table})`);
    expect(strays, 'open or seal through lib/contentCipher.ts, then list the file here').toEqual(
      []
    );
  });

  it('refuses such SQL in a function that neither opens nor seals', () => {
    const raw = scan()
      .filter(({ handled, table, file }) => !handled && !RAW_ON_PURPOSE[file]?.includes(table))
      .map(({ table, file, line }) => `${file}:${line} (${table})`);
    expect(raw, 'the function holding this SQL calls no open or seal helper').toEqual([]);
  });

  it('drops a raw-on-purpose entry that no longer matches raw SQL', () => {
    const raw = scan().filter(({ handled }) => !handled);
    const stale = Object.entries(RAW_ON_PURPOSE).flatMap(([file, columns]) =>
      columns
        .filter((column) => !raw.some((hit) => hit.file === file && hit.table === column))
        .map((column) => `${file} (${column})`)
    );
    expect(stale).toEqual([]);
  });

  it('drops a listed file that no longer names its column', () => {
    const found = scan();
    const stale = Object.entries(ALLOWLIST).flatMap(([table, files]) =>
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
    expect(byStatement(sealedSql(source, 'probe.ts'))).toEqual([
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
    expect(byStatement(sealedSql(source, 'probe.ts'))).toEqual([
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

  it('holds a note to what fits sealed, and the notes editor caps typing at it (MICA-431)', () => {
    expect(rule(notes, 'content')).toBe(maxPlaintextChars(65535));
    expect(NOTE_CONTENT_MAX).toBe(maxPlaintextChars(65535));
    expect(rule(notes, 'title')).toBe(NOTE_TITLE_MAX);
    const editor = readFileSync(
      join(ROOT, 'web/src/apps/notes/components/NoteEditor.svelte'),
      'utf8'
    );
    expect(editor).toContain('maxlength={NOTE_CONTENT_MAX}');
    expect(editor).toContain('maxlength={NOTE_TITLE_MAX}');
  });

  it('keeps a varchar plaintext bound and emits the column as wide as its sealed form', () => {
    expect(rule(directMessages, 'body')).toBe(500);
    expect(stored(directMessages, 'body').length).toBe(sealedLengthForChars(500));
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

  it('matches migration 0013, whose widths are frozen, for every varchar MICA-431 sealed', () => {
    const text = readFileSync(
      join(ROOT, 'server/migrations/0013_private_content_widens_its_columns.ts'),
      'utf8'
    ).replace(/\s+/g, ' ');
    const sealedHere = [
      ['notes', 'title'],
      ['contacts', 'firstname'],
      ['contacts', 'lastname'],
      ['contacts', 'email'],
      ['phone_call_log', 'number'],
      ['places', 'name'],
      ['places', 'street_label'],
      ['media', 'alt_text'],
      ['notifications', 'title'],
      ['notifications', 'body'],
      ['reports', 'note'],
      ['darkchat_messages', 'bot_alias']
    ];
    for (const [id, column] of sealedHere) {
      const service = declaredServices.find((s) => s.id === id)!;
      const def = service.fields.find((f: any) => f.name === column)!.def as any;
      expect(def.type, `${id}.${column}`).toBe('string');
      expect(text, `${id}.${column}`).toContain(`table: '${service.table}', columns: [`);
      expect(text, `${id}.${column}`).toContain(`{ column: '${column}', width: ${def.length},`);
      // As wide as its plaintext bound, sealed at four bytes a character.
      expect(def.length).toBe(sealedLengthForChars(service.columnRules[column].maxLength!));
    }
  });

  it('registers a declared table exactly once', () => {
    // A child table's sealed columns (MICA-432) are its service's to declare too.
    const tables = declaredServices.flatMap((s) => [s.table, ...s.childTables.map((c) => c.name)]);
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

  it('refuses device_id in the scope, which a phone-bound value binds already (MICA-431)', () => {
    expect(() =>
      resolveAppSchema({
        id: 'sealed_device_probe',
        deviceOwned: true,
        access: { read: 'owner', write: 'owner' },
        schema: { body: { type: 'string', length: 100, encrypted: true } },
        encryptionScope: ['device_id']
      } as any)
    ).toThrow(/cannot bind/);
  });

  it('sizes an ASCII column at one byte a character, and refuses ascii alone', () => {
    const photo = resolveAppSchema({
      id: 'sealed_ascii_probe',
      schema: { data: { type: 'mediumtext', encrypted: true, ascii: true } },
      encryptionScope: []
    } as any);
    expect(photo.columnRules.data.maxLength).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(photo.columnRules.data.ascii).toBe(true);
    expect(() =>
      resolveAppSchema({ id: 'ascii_alone_probe', schema: { data: { type: 'text', ascii: true } } })
    ).toThrow(/'ascii' but not 'encrypted'/);
  });

  it("binds every phone-owned table's sealed columns to the phone, and every other to the character", () => {
    // A loop over an empty set asserts nothing: there are phone-owned sealed columns to check.
    const phoneTables = new Set(declaredServices.filter((d) => d.deviceOwned).map((d) => d.table));
    const sealed = encryptedColumns();
    expect(sealed.some((entry) => phoneTables.has(entry.table))).toBe(true);
    // And a table whose owner passes on is bound to its rows (MICA-432); a child table to the
    // member who wrote the row.
    const rowTables = new Set(
      declaredServices.filter((d) => d.encryptionBinding === 'row').map((d) => d.table)
    );
    expect(sealed.some((entry) => rowTables.has(entry.table))).toBe(true);
    for (const entry of sealed) {
      expect(entry.binding, `${entry.table}.${entry.column}`).toBe(
        phoneTables.has(entry.table) ? 'device' : rowTables.has(entry.table) ? 'row' : 'citizen'
      );
    }
  });

  it('puts a blind index right after its value, private and never written by a client (MICA-432)', () => {
    const resolved = resolveAppSchema({
      id: 'index_probe',
      deviceOwned: true,
      schema: {
        phone: {
          type: 'string',
          length: 20,
          encrypted: true,
          blindIndex: { scope: ['device_id'] }
        },
        label: 'string'
      },
      encryptionScope: []
    } as any);
    const names = resolved.fields.map((f: any) => f.name);
    expect(names.slice(names.indexOf('phone'), names.indexOf('phone') + 2)).toEqual([
      'phone',
      'phone_index'
    ]);
    expect(resolved.fields.find((f: any) => f.name === 'phone_index')!.def).toMatchObject({
      length: 81,
      private: true,
      clientWritable: false
    });
    expect(resolved.clientWritable).not.toContain('phone_index');
    expect(resolved.blindIndexes).toEqual([
      expect.objectContaining({ column: 'phone', index: 'phone_index', scope: ['device_id'] })
    ]);
  });

  it.each([
    [
      'a blind index over plaintext',
      { schema: { code: { type: 'string', length: 8, blindIndex: {} } } },
      /not 'encrypted'/
    ],
    [
      'a blind index scoped by a column that is not there',
      {
        schema: {
          code: { type: 'string', length: 8, encrypted: true, blindIndex: { scope: ['nope'] } }
        },
        encryptionScope: []
      },
      /not another column/
    ],
    [
      'a blind index scoped by a sealed column',
      {
        schema: {
          code: { type: 'string', length: 8, encrypted: true, blindIndex: { scope: ['room'] } },
          room: { type: 'string', length: 8, encrypted: true }
        },
        encryptionScope: []
      },
      /an encrypted column/
    ],
    [
      'a row binding on a phone',
      { deviceOwned: true, encryptionBinding: 'row', schema: { name: 'string' } },
      /deviceOwned/
    ],
    [
      'a binding that is not one',
      { encryptionBinding: 'owner', schema: { name: 'string' } },
      /is not one/
    ],
    [
      'a seal key declared by hand',
      { encryptionBinding: 'row', schema: { seal_key: 'string' } },
      /supplied by/
    ]
  ])('refuses %s (MICA-432)', (_label, over, message) => {
    expect(() => resolveAppSchema({ id: 'refusal_probe', ...over } as any)).toThrow(message);
  });

  it('adds the seal key a row-bound table is sealed to (MICA-432)', () => {
    const resolved = resolveAppSchema({
      id: 'row_probe',
      encryptionBinding: 'row',
      encryptionScope: [],
      schema: { name: { type: 'string', length: 32, encrypted: true } }
    } as any);
    expect(resolved.encryptionBinding).toBe('row');
    expect(resolved.fields.find((f: any) => f.name === 'seal_key')!.def).toMatchObject({
      length: 32,
      private: true,
      clientWritable: false
    });
  });

  it("seals a child table's columns under its own scope, widened, with its indexes (MICA-432)", () => {
    const child = (over: Record<string, unknown>) => ({
      name: 'probe_members',
      columns: {
        room_id: { type: 'int', notNull: true },
        citizenid: { type: 'string', citizenId: true, notNull: true },
        alias: { type: 'string', length: 24, encrypted: true, blindIndex: { scope: ['room_id'] } }
      },
      ...over
    });
    const declareChild = (over: Record<string, unknown>, columns?: Record<string, unknown>) =>
      resolveAppSchema({
        id: 'child_probe',
        schema: { topic: 'string' },
        childTables: [columns ? { ...child(over), columns } : child(over)]
      } as any);
    const resolved = declareChild({ encryptionScope: ['room_id'] });
    expect(resolved.childEncryption).toEqual([
      expect.objectContaining({ table: 'probe_members', columns: ['alias'], scope: ['room_id'] })
    ]);
    const columns = resolved.childTables[0].columns as Record<string, any>;
    expect(columns.alias.length).toBe(sealedLengthForChars(24));
    expect(columns.alias_index).toMatchObject({ length: 81, clientWritable: false });
    expect(() => declareChild({})).toThrow(/no 'encryptionScope'/);
    expect(() =>
      declareChild(
        { encryptionScope: [] },
        { alias: { type: 'string', length: 24, encrypted: true } }
      )
    ).toThrow(/no 'citizenid'/);
    expect(() => declareChild({ encryptionScope: ['alias'] })).toThrow(/cannot bind/);
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
  // MICA-430: a versioned write, through this suite's own stand-in.
  versionCalls = versionedWrites(dbMock);
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
    // A thread's live members (`findParticipants`): the caller on the phone in hand, and Bea.
    // `messages:send` decides membership from this read since MICA-367.
    if (text.includes('WHERE p.conversation_id = ? AND p.left_at IS NULL')) {
      const member = {
        conversation_id: params[0],
        role: 'member',
        status: 'active',
        left_at: null
      };
      return [
        { ...member, id: 1, citizenid: player.current, device_id: TEST_PHONE_ID },
        { ...member, id: 2, citizenid: 'CIT_B', device_id: 'f'.repeat(32) }
      ];
    }
    return answerQuery(text, params);
  });
  dbMock.insert.mockImplementation(async (sql: string, params: unknown[] = []) => {
    inserts.push({ sql: String(sql), params });
    nextId += 1;
    return nextId;
  });
  dbMock.single.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    // The phone in hand has a number of its own; a text from one without is refused (MICA-346).
    if (text.includes('`mica_phone_numbers`') && /WHERE `device_id` = \?/.test(text)) {
      return { id: 1, citizenid: player.current, number: '5550100', status: 'active' };
    }
    return answerSingle(text, params);
  });
  dbMock.update.mockResolvedValue(true);
  dbMock.scalar.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `row` cut to what a statement's select list would hand back, the way a real result set is: a
 * stub that answers the whole row hides a read that forgot a column the authenticated data
 * binds, which then fails only against a database (the DM reads, in-server run 39242728050).
 *
 * Reads the list up to the top-level `FROM`, skipping subqueries and quoted text. An item is
 * named by its `AS` alias, else its last identifier (`m.citizenid`, `` `body` ``); `*` or `m.*`
 * keeps the whole row, which is that table's row. A name the row does not hold is left out, so
 * a stub may carry a computed column (`edited`, `preview`) under its alias.
 */
const selectedFrom = <R extends Record<string, unknown>>(sql: string, row: R): Partial<R> => {
  const head = /^\s*SELECT\s+(?:DISTINCT\s+)?/i.exec(sql);
  if (!head) throw new Error(`selectedFrom: not a SELECT: ${sql}`);
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let item = '';
  let i = head[0].length;
  for (; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      item += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && ch === ',') {
      items.push(item);
      item = '';
      continue;
    } else if (depth === 0 && /^FROM\b/i.test(sql.slice(i)) && /\s/.test(sql[i - 1])) break;
    item += ch;
  }
  if (i >= sql.length) throw new Error(`selectedFrom: no top-level FROM in ${sql}`);
  items.push(item);
  const names = items.map((text) => {
    const trimmed = text.trim();
    if (trimmed === '*' || /^`?[a-z_]+`?\.\*$/i.test(trimmed)) return '*';
    const alias = /\bAS\s+`?([a-z_]+)`?$/i.exec(trimmed);
    if (alias) return alias[1];
    const last = /`?([a-z_]+)`?$/i.exec(trimmed);
    if (!last) throw new Error(`selectedFrom: cannot name '${trimmed}' in ${sql}`);
    return last[1];
  });
  if (names.includes('*')) return { ...row };
  return Object.fromEntries(
    names.filter((name) => name in row).map((name) => [name, row[name]])
  ) as Partial<R>;
};

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
      {
        table: 'mica_messages',
        column: 'message',
        binding: 'citizen',
        owner: 'CIT_B',
        ownerKind: 'citizen',
        scope: [7]
      },
      'hi there'
    );
    answerSingle = (sql) => (sql.includes('mica_messages_participants') ? { 1: 1 } : null);
    answerQuery = (sql) =>
      sql.includes('FROM mica_messages m')
        ? [
            selectedFrom(sql, {
              id: 1,
              conversation_id: 7,
              citizenid: 'CIT_B',
              message: sealed,
              edited: 0
            })
          ]
        : [];

    const reply = await call('messages', 'get', { conversation_id: 7 });

    expect(reply.rows[0].message).toBe('hi there');
  });

  it('shows a padlock for a body copied into another conversation, and keeps the thread', async () => {
    const moved = await sealContent(
      {
        table: 'mica_messages',
        column: 'message',
        binding: 'citizen',
        owner: 'CIT_B',
        ownerKind: 'citizen',
        scope: [8]
      },
      'from elsewhere'
    );
    answerSingle = (sql) => (sql.includes('mica_messages_participants') ? { 1: 1 } : null);
    answerQuery = (sql) =>
      sql.includes('FROM mica_messages m')
        ? [
            { id: 2, conversation_id: 7, citizenid: 'CIT_B', message: 'legacy text', edited: 0 },
            { id: 1, conversation_id: 7, citizenid: 'CIT_B', message: moved, edited: 0 }
          ].map((row) => selectedFrom(sql, row))
        : [];

    const reply = await call('messages', 'get', { conversation_id: 7 });

    expect(reply.rows.map((r: any) => r.message)).toEqual([UNREADABLE_CONTENT, 'legacy text']);
  });

  it('seals an edit against the row’s own context, read by id', async () => {
    const original = await sealContent(
      {
        table: 'mica_messages',
        column: 'message',
        binding: 'citizen',
        owner: 'CIT_A',
        ownerKind: 'citizen',
        scope: [7]
      },
      'teh plan'
    );
    answerSingle = (sql) => {
      if (sql.includes('mica_messages_participants')) return { 1: 1 };
      const stored = { id: 3, conversation_id: 7, citizenid: 'CIT_A', message: original };
      if (sql.startsWith('SELECT `citizenid`, `conversation_id`')) {
        return selectedFrom(sql, stored);
      }
      if (sql.startsWith('SELECT * FROM `mica_messages`')) return selectedFrom(sql, stored);
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
      {
        table: 'mica_messages',
        column: 'message',
        binding: 'citizen',
        owner: 'CIT_B',
        ownerKind: 'citizen',
        scope: [9]
      },
      'see you'
    );
    answerQuery = (sql) =>
      sql.includes('last_message_text')
        ? [
            selectedFrom(sql, {
              id: 9,
              updated_at: '2026-09-01 10:00:00',
              last_message_text: sealed,
              last_message_time: '2026-09-01 10:00:00',
              last_message_sender: 'CIT_B'
            })
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

    const reply = await call('dms', 'send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: 'secret plans'
    });

    expect(reply.body).toBe('secret plans');
    const [row] = insertedInto('mica_blabber_dms');
    expect(isSealed(row.body)).toBe(true);
    await vi.waitFor(() => expect(insertedInto('mica_notifications')).toHaveLength(1));
    const [notification] = insertedInto('mica_notifications');
    // The body is sealed itself since MICA-431, to the phone it landed on: still nothing in it.
    expect(isSealed(notification.body)).toBe(true);
    expect(
      openContent(
        contentContext(encryptedColumn('mica_notifications', 'body')!, notification),
        String(notification.body)
      )
    ).toBe('');
    expect(JSON.stringify(notification)).not.toContain('secret plans');
  });

  /**
   * The stored row is handed back as MariaDB would: only the columns the SELECT names. This
   * answered the whole row whatever was asked for, so it passed while both reads left out the
   * `citizenid` the body's authenticated data binds, and every sealed thread read threw in a
   * real server (in-server run 39242728050).
   */
  it('opens a thread and the inbox’s last messages from the columns they select', async () => {
    const sealed = await sealContent(
      {
        table: 'mica_blabber_dms',
        column: 'body',
        binding: 'citizen',
        owner: 'CIT_B',
        ownerKind: 'citizen',
        scope: [2, 1]
      },
      'hello ada'
    );
    const stored = {
      id: 5,
      citizenid: 'CIT_B',
      from_account: 2,
      to_account: 1,
      body: sealed,
      read_at: null,
      status: 'active',
      created_at: '2026-10-19 00:00:00',
      updated_at: '2026-10-19 00:00:00'
    };
    answerSingle = (sql) => (sql.includes('mica_accounts') ? MINE : null);
    answerQuery = (sql) => {
      if (sql.includes('GROUP BY peer')) return [{ peer: 2, last_id: 5 }];
      if (sql.includes('COUNT(*) AS total')) return [];
      if (sql.includes('mica_blabber_dms')) return [selectedFrom(sql, stored)];
      if (sql.includes('mica_accounts')) return [MINE, PEER];
      return [];
    };

    const thread = await call('dms', 'get', { app: 'blabber', account_id: 1, peer_account_id: 2 });
    expect(thread.rows[0].body).toBe('hello ada');
    expect(thread.rows[0]).not.toHaveProperty('citizenid');

    const inbox = await call('dms', 'threads', { app: 'blabber' });
    expect(inbox[0].last.body).toBe('hello ada');
    expect(inbox[0].last).not.toHaveProperty('citizenid');
  });

  it('opens through the generic projection, and drops the context it added', async () => {
    const sealed = await sealContent(
      {
        table: 'mica_blabber_dms',
        column: 'body',
        binding: 'citizen',
        owner: 'CIT_A',
        ownerKind: 'citizen',
        scope: [1, 2]
      },
      'projected'
    );
    answerQuery = (sql) =>
      sql.startsWith('SELECT `body`, `citizenid`, `from_account`, `to_account` FROM')
        ? [{ body: sealed, citizenid: 'CIT_A', from_account: 1, to_account: 2 }]
        : [];

    const rows = await directMessages.repo.findAll({ citizenid: 'CIT_A' } as any, undefined, [
      'body'
    ]);

    expect(rows).toEqual([{ body: 'projected' }]);
  });
});

describe('Dark Chat (mica_darkchat_messages.body)', () => {
  /**
   * The channel page is Dark Chat's one read that opens bodies. Each row is sealed under its own
   * `citizenid` — the author's, or the channel owner's for an export's line — and the channel, so
   * the page must select both even though neither the author nor the owner may reach a reader.
   */
  it('opens a channel page from the columns it selects, and drops whose the rows are', async () => {
    const sealedFor = (citizenid: string, text: string) =>
      sealContent(
        {
          table: 'mica_darkchat_messages',
          column: 'body',
          binding: 'citizen',
          owner: citizenid,
          ownerKind: 'citizen',
          scope: [7]
        },
        text
      );
    const stored = [
      {
        id: 12,
        citizenid: 'CIT_B',
        channel_id: 7,
        author_member_id: 3,
        bot_alias: null,
        body: await sealedFor('CIT_B', 'meet at dawn'),
        status: 'active',
        created_at: '2026-10-19 00:00:00',
        updated_at: '2026-10-19 00:00:00',
        member_alias: 'raven',
        member_handle: 'h3'
      },
      {
        id: 11,
        citizenid: 'CIT_OWNER',
        channel_id: 7,
        author_member_id: null,
        bot_alias: 'Dispatch',
        body: await sealedFor('CIT_OWNER', 'shift starts'),
        status: 'active',
        created_at: '2026-10-19 00:00:00',
        updated_at: '2026-10-19 00:00:00',
        member_alias: null,
        member_handle: null
      }
    ];
    answerSingle = (sql) =>
      sql.includes('FROM `mica_darkchat_members` m')
        ? { id: 1, alias: 'crow', handle: 'h1' }
        : null;
    answerQuery = (sql) =>
      sql.includes('FROM `mica_darkchat_messages` msg')
        ? stored.map((row) => selectedFrom(sql, row))
        : [];

    const page = await call('darkchat_messages', 'list', { channel_id: 7 });

    // A page, not the generic error a failed open answers — so a break shows the reply.
    expect(page).toEqual({ rows: expect.any(Array), nextCursor: null });
    expect(page.rows.map((row: { body: string }) => row.body)).toEqual([
      'meet at dawn',
      'shift starts'
    ]);
    expect(page.rows.map((row: { alias: string }) => row.alias)).toEqual(['raven', 'Dispatch']);
    for (const row of page.rows) {
      expect(row).not.toHaveProperty('citizenid');
      expect(row).not.toHaveProperty('author_member_id');
    }
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
      {
        table: 'mica_mail',
        column: 'content',
        binding: 'citizen',
        owner: 'CIT_A',
        ownerKind: 'citizen',
        scope: []
      },
      'your statement'
    );
    answerQuery = (sql) =>
      sql.includes('FROM `mica_mail`')
        ? [selectedFrom(sql, { id: 1, citizenid: 'CIT_A', content: sealed })]
        : [];

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
      {
        table: 'mica_blabber_dms',
        column: 'body',
        binding: 'citizen',
        owner: 'CIT_B',
        ownerKind: 'citizen',
        scope: [2, 1]
      },
      'you will regret this'
    );
    answerSingle = (sql) =>
      sql.includes('FROM `mica_blabber_dms`')
        ? selectedFrom(sql, {
            citizenid: 'CIT_B',
            status: 'active',
            preview: dm,
            from_account: 2,
            to_account: 1
          })
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
        binding: 'citizen',
        owner: 'CIT_A',
        ownerKind: 'citizen',
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
    answerQuery = (sql) => (sql.includes('`mica_reports`') ? [selectedFrom(sql, row)] : []);

    const queue = await call('reports', 'queue', undefined, 0);
    expect(queue[0].target_preview).toBe('you will regret this');
    const history = await call('reports', 'history', undefined, 0);
    expect(history[0].target_preview).toBe('you will regret this');
  });
});

/**
 * MICA-431: a phone's own content, sealed to the phone. Each round trip seals through the real
 * path, then opens under the row's context — and, the binding's point, opens whatever
 * citizenid the row carries (a handover before MICA-436 rewrote it), and not on another phone.
 */
describe("a phone's own content (MICA-431)", () => {
  const PHONE = TEST_PHONE_ID;
  const onPhone = (table: string, column: string, row: Record<string, unknown>) =>
    openContent(contentContext(encryptedColumn(table, column)!, row), String(row[column]));

  it('seals a note to the phone it is written on, and opens it on that phone alone', async () => {
    const reply = await call('notes', 'create', { title: 'groceries', content: 'milk, eggs' });
    expect(reply.title).toBe('groceries');

    const [row] = insertedInto('mica_notes');
    expect(row.device_id).toBe(PHONE);
    expect(isSealed(row.title)).toBe(true);
    expect(isSealed(row.content)).toBe(true);
    expect(JSON.stringify(row)).not.toContain('milk');
    expect(onPhone('mica_notes', 'content', row)).toBe('milk, eggs');
    // The same phone, another citizenid: what a handover before MICA-436 left.
    expect(onPhone('mica_notes', 'content', { ...row, citizenid: 'CIT_THIEF' })).toBe('milk, eggs');
    // The positive twin's negative: another phone's row will not open it.
    expect(onPhone('mica_notes', 'content', { ...row, device_id: 'f'.repeat(32) })).toBe(
      UNREADABLE_CONTENT
    );

    // And the list opens it from the columns it selects.
    const stored = { id: 101, status: 'active', updated_at: 'now', created_at: 'now', ...row };
    answerQuery = (sql) => (sql.includes('`mica_notes`') ? [selectedFrom(sql, stored)] : []);
    const list = await call('notes', 'get', {});
    expect(list[0]).toMatchObject({ title: 'groceries', content: 'milk, eggs' });
  });

  it('seals a notification to the phone, clipped to its bound, and the shade opens it', async () => {
    const repo = getNotificationsRepository()!;
    await repo.createNotificationBatch([
      { citizenid: 'CIT_A', app: 'mail', kind: 'new', title: 'é'.repeat(100), body: 'lunch?' }
    ]);
    const [row] = insertedInto('mica_notifications');
    expect(row.device_id).toBe(PHONE);
    expect(isSealed(row.title)).toBe(true);
    expect(onPhone('mica_notifications', 'title', row)).toBe('é'.repeat(80));
    expect(onPhone('mica_notifications', 'body', row)).toBe('lunch?');

    answerQuery = (sql) => (sql.includes('mica_notifications') ? [{ id: 1, ...row }] : []);
    const shade = await repo.findShadeNotifications('CIT_A', PHONE);
    expect(shade[0]).toMatchObject({ title: 'é'.repeat(80), body: 'lunch?' });
  });

  it("re-seals a dropped photo for each recipient's own phone", async () => {
    // On a phone of its own: the stub hands every recipient `PHONE`, and a copy sealed to the
    // sender's phone must be told apart from one sealed to the recipient's.
    const source = {
      id: 42,
      citizenid: 'CIT_A',
      device_id: 'c'.repeat(32),
      kind: 'photo',
      data: 'data:image/png;base64,AAAA',
      thumbnail: 'data:image/png;base64,TT',
      alt_text: 'the pier',
      url: null,
      status: 'active'
    };
    const written = await (media.repo as any).copyToPlayers(['CIT_B'], source);
    expect(written).toEqual(['CIT_B']);

    const [[sql, params]] = dbMock.insert.mock.calls as [string, unknown[]][];
    const copy = rowOf(String(sql), params);
    expect(copy.citizenid).toBe('CIT_B');
    expect(copy.device_id).toBe(PHONE);
    for (const column of ['data', 'thumbnail', 'alt_text']) {
      expect(isSealed(copy[column])).toBe(true);
      expect(onPhone('mica_media', column, copy)).toBe((source as any)[column]);
    }
    // Sealed for the recipient's row, not for the sender's: under the sender's phone it does
    // not open.
    expect(onPhone('mica_media', 'data', { ...copy, device_id: source.device_id })).toBe(
      UNREADABLE_CONTENT
    );
    // A source that did not open is not copied as a padlock.
    dbMock.insert.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await (media.repo as any).copyToPlayers(['CIT_B'], { ...source, data: UNREADABLE_CONTENT })
    ).toEqual([]);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("holds the quota-gated insert to the column's bound before it seals", async () => {
    // The default ceiling is on, so this is `insertWithinQuota`'s own statement, not `create`'s.
    const repo = media.repo as any;
    const photo = { citizenid: 'CIT_A', device_id: PHONE, kind: 'photo', data: 'x' };
    await expect(repo.insertOwned({ ...photo, alt_text: 'a'.repeat(256) })).rejects.toMatchObject({
      key: 'server.repository.maxLength'
    });
    expect(dbMock.insert).not.toHaveBeenCalled();
    // The twin: at the bound it is written, sealed.
    await repo.insertOwned({ ...photo, alt_text: 'a'.repeat(255) });
    const [sql] = dbMock.insert.mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain('AS quota');
    const [row] = insertedInto('mica_media');
    expect(onPhone('mica_media', 'alt_text', row)).toBe('a'.repeat(255));
  });

  it('seals a stored thumbnail to the phone the row is on', async () => {
    await (media.repo as any).storeThumbnail(7, 'CIT_A', PHONE, 'data:image/png;base64,TT');
    const [, params] = dbMock.update.mock.calls[0] as [string, unknown[]];
    expect(isSealed(params[0])).toBe(true);
    expect(
      onPhone('mica_media', 'thumbnail', {
        citizenid: 'CIT_A',
        device_id: PHONE,
        thumbnail: params[0]
      })
    ).toBe('data:image/png;base64,TT');
  });

  it("refuses a non-ASCII value in an ASCII column, and stores the server's own JSON", async () => {
    const repo = media.repo as any;
    await expect(
      repo.addForPlayer('CIT_A', { kind: 'location', data: '{"label":"café"}', device_id: PHONE })
    ).rejects.toMatchObject({ key: 'server.repository.notAccepted' });
    expect(insertedInto('mica_media')).toHaveLength(0);
    // The positive twin: a location's JSON is no inline image, and the client's `accepts` rule
    // is not what a sealed write is held to.
    await repo.addForPlayer('CIT_A', { kind: 'location', data: '{"x":1}', device_id: PHONE });
    const [row] = insertedInto('mica_media');
    expect(onPhone('mica_media', 'data', row)).toBe('{"x":1}');
  });

  it('opens a joined photo off its own phone, and hands back neither its owner nor its phone', async () => {
    const photo = {
      citizenid: 'CIT_UPLOADER',
      device_id: 'a'.repeat(32),
      data: 'x',
      alt_text: 'y'
    };
    const sealedData = await sealContent(
      contentContext(encryptedColumn('mica_media', 'data')!, photo),
      'data:image/png;base64,AAAA'
    );
    const sealedAlt = await sealContent(
      contentContext(encryptedColumn('mica_media', 'alt_text')!, photo),
      'a dog'
    );
    answerQuery = (sql) =>
      sql.includes('mica_blabber_attachments')
        ? [
            selectedFrom(sql, {
              id: 1,
              blab_id: 8,
              media_id: 5,
              kind: 'photo',
              data: sealedData,
              thumbnail: null,
              alt_text: sealedAlt,
              media_citizenid: photo.citizenid,
              media_device_id: photo.device_id
            })
          ]
        : [];
    const found = await (blabber.repo as any).findAttachmentsFor([8]);
    const [attachment] = found.get(8);
    expect(attachment.media).toMatchObject({
      data: 'data:image/png;base64,AAAA',
      alt_text: 'a dog'
    });
    expect(JSON.stringify([...found])).not.toMatch(/CIT_UPLOADER|aaaaaaaa/);
  });

  it("opens a reported photo's preview off the photo's phone", async () => {
    const photo = { citizenid: 'CIT_B', device_id: 'b'.repeat(32) };
    const data = await sealContent(
      contentContext(encryptedColumn('mica_media', 'data')!, photo),
      'data:image/png;base64,QQ'
    );
    answerSingle = (sql) =>
      sql.includes('FROM `mica_media`')
        ? selectedFrom(sql.replace(/\s+/g, ' '), {
            ...photo,
            status: 'active',
            preview: data
          })
        : null;
    const summary = await summariseTarget('mica_media' as any, 3);
    expect(summary).toMatchObject({ exists: true, preview: 'data:image/png;base64,QQ' });
  });
});

/**
 * MICA-432: the columns that needed a lookup key or a schema change, through the real paths with
 * a key loaded. Each opens again under its own binding, and each lookup finds a value by the
 * blind index in every form a stored one can take.
 */
describe('lookups and moved owners (MICA-432)', () => {
  const opened = (table: string, column: string, row: Record<string, unknown>) =>
    openContent(contentContext(encryptedColumn(table, column)!, row), String(row[column]));

  it("seals a contact's number to the phone, and indexes it under the key", async () => {
    dbMock.scalar.mockResolvedValue(null);
    await call('contacts', 'create', { firstname: 'Ada', phone: '555-0100' });
    const [row] = insertedInto('mica_contacts');
    expect(isSealed(row.phone)).toBe(true);
    expect(opened('mica_contacts', 'phone', row)).toBe('555-0100');
    expect(String(row.phone_index)).toMatch(/^k1\$[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('555-0100');
    // Asked first, by every form the index can take: the key's, then the no-key one.
    const [, params] = dbMock.scalar.mock.calls.find(([sql]) =>
      String(sql).includes('`phone_key` IN (')
    )!;
    expect(params).toEqual([TEST_PHONE_ID, row.phone_index, 'plain:555-0100']);
  });

  it('refuses a number the phone holds under an index from before the key', async () => {
    // A live row written before the first key still carries `plain:`; the unique key cannot see
    // it is the same number, so the write's own read is what refuses.
    dbMock.scalar.mockImplementation(async (sql: string, params: unknown[] = []) =>
      String(sql).includes('`phone_key` IN (') && params.includes('plain:555-0100') ? 7 : null
    );
    const reply = await call('contacts', 'create', { firstname: 'Ada', phone: '555-0100' });
    expect(reply).toMatchObject({ key: 'server.contacts.numberTaken' });
    expect(insertedInto('mica_contacts')).toHaveLength(0);
  });

  it("seals a Dark Chat channel to the channel, and finds it by its code's index", async () => {
    const reply = await call('darkchat', 'create', { name: 'Docks', alias: 'Moth' });
    const [channel] = insertedInto('mica_darkchat');
    expect(String(channel.seal_key)).toMatch(/^[0-9a-f]{32}$/);
    expect(opened('mica_darkchat', 'name', channel)).toBe('Docks');
    // Bound to the channel, not its owner: the heir opens it.
    expect(opened('mica_darkchat', 'name', { ...channel, citizenid: 'HEIR' })).toBe('Docks');
    expect(opened('mica_darkchat', 'code', channel)).toBe(reply.code);
    expect(String(channel.code_index)).toMatch(/^k1\$/);
    const [member] = insertedInto('mica_darkchat_members');
    expect(opened('mica_darkchat_members', 'alias', member)).toBe('Moth');
    expect(String(member.alias_index)).toMatch(/^k1\$/);
    expect(JSON.stringify([channel, member])).not.toMatch(/Docks|Moth/);

    answerSingle = (sql, params) =>
      sql.includes('`code_index` IN (') && params.includes(channel.code_index)
        ? { id: 77, citizenid: 'CIT_A' }
        : null;
    expect(await liveChannelByCode(String(reply.code).toLowerCase())).toEqual({
      id: 77,
      citizenid: 'CIT_A'
    });
  });

  it("seals a saved place's position to the phone, and hands back x, y and z", async () => {
    const repo = places.repo as any;
    await repo.addForPlayer('CIT_A', TEST_PHONE_ID, { name: 'Home', x: 1.5, y: -2, z: 30 });
    const [row] = insertedInto('mica_places');
    expect(isSealed(row.position)).toBe(true);
    expect(JSON.parse(opened('mica_places', 'position', row))).toEqual({ x: 1.5, y: -2, z: 30 });
    answerSingle = (sql) =>
      sql.includes('`mica_places`') ? selectedFrom(sql, { id: 5, status: 'active', ...row }) : null;
    expect(await repo.findById(5, 'CIT_A', TEST_PHONE_ID)).toMatchObject({
      name: 'Home',
      x: 1.5,
      y: -2,
      z: 30
    });
  });

  it("seals a mail's sender and subject, and an invoice's label and memo, to the reader", async () => {
    await SendSystemEmail('CIT_B', { sender: 'Maze Bank', subject: 'Overdraft', content: 'hi' });
    const [letter] = insertedInto('mica_mail');
    expect(opened('mica_mail', 'sender', letter)).toBe('Maze Bank');
    expect(opened('mica_mail', 'subject', letter)).toBe('Overdraft');
    expect(JSON.stringify(letter)).not.toMatch(/Maze Bank|Overdraft/);

    const label = await sealContent(
      contentContext(encryptedColumn('mica_invoices', 'from_label')!, { citizenid: 'CIT_A' }),
      'LS Customs'
    );
    answerQuery = (sql) =>
      sql.includes('`mica_invoices`')
        ? [selectedFrom(sql, { id: 3, citizenid: 'CIT_A', from_label: label, memo: null })]
        : [];
    const open = await (invoices.repo as any).findOpen('CIT_A', 0);
    expect(open).toEqual([expect.objectContaining({ id: 3, from_label: 'LS Customs' })]);
    expect(open[0]).not.toHaveProperty('citizenid');
  });

  it('lets no reply carry an index, a key generated over one, or a seal key', () => {
    const reply = withoutOwnerKeys({
      id: 1,
      phone: '555-0100',
      phone_index: 'k1$ab',
      phone_key: 'k1$ab',
      seal_key: 'k'.repeat(32),
      members: [{ alias: 'Moth', alias_index: 'k1$cd', alias_key: 'k1$cd', handle_index: 'k1$ef' }],
      channel: { name: 'Docks', code_index: 'plain:ABCD2345' },
      pair_label: 'kept'
    });
    // Registered from the declarations, so a custom reply written later is covered too.
    expect(reply).toEqual({
      id: 1,
      phone: '555-0100',
      members: [{ alias: 'Moth' }],
      channel: { name: 'Docks' },
      pair_label: 'kept'
    });
  });

  it("seals a thread's name to the thread, so whoever holds it can rename and read it", async () => {
    dbMock.scalar.mockImplementation(async (sql: string) =>
      String(sql).startsWith('SELECT seal_key FROM mica_messages_conversations')
        ? 'k'.repeat(32)
        : null
    );
    await (conversations.repo as any).renameAsAdmin(4, 'Crew', 'CIT_A', TEST_PHONE_ID);
    const [, params] = dbMock.update.mock.calls.at(-1) as [string, unknown[]];
    expect(isSealed(params[0])).toBe(true);
    expect(
      opened('mica_messages_conversations', 'name', { seal_key: 'k'.repeat(32), name: params[0] })
    ).toBe('Crew');
    expect(params[2]).toBe('k'.repeat(32));
    // The name it replaced is kept, sealed as the row held it, beside its seal key (MICA-430).
    expect(versionCalls.map((c) => [c.table, c.reason, c.editedBy])).toEqual([
      ['mica_messages_conversations', 'rename', 'CIT_A']
    ]);
    expect(versionCalls[0].snapshot).toContain(
      "JSON_OBJECT('values', JSON_OBJECT('name', c.`name`), 'context', JSON_OBJECT('citizenid', c.`citizenid`, 'seal_key', c.`seal_key`)"
    );
    expect(versionCalls[0].lock).toMatch(
      /^SELECT c\.`id` FROM `mica_messages_conversations` c WHERE c\.id = \?/
    );
  });
});

describe('the privacy export', () => {
  it('returns a player their own words, not ciphertext, and adds no column', async () => {
    const sealed = await sealContent(
      {
        table: 'mica_messages',
        column: 'message',
        binding: 'citizen',
        owner: 'CIT_A',
        ownerKind: 'citizen',
        scope: [7]
      },
      'my own words'
    );
    answerQuery = (sql) =>
      /FROM `mica_messages` WHERE/.test(sql)
        ? [selectedFrom(sql, { id: 1, conversation_id: 7, message: sealed, citizenid: 'CIT_A' })]
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
    await call('dms', 'send', {
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: LOOKALIKE
    });
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
    const dm = await call('dms', 'send', {
      app: 'blabber',
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
