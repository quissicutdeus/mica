// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript-ast-parser';
import { NO_REASON, reasonOf } from '../lib/sqlErrors';
import { duplicateEntry, oxmysqlRejection } from './oxmysqlRejection';

/**
 * Why something failed, read the one way that survives a realm boundary.
 *
 * oxmysql rejects with `new Error(output)` built inside its own resource, so in micaOS's realm
 * `error instanceof Error` is false on every real driver failure. A reason read as
 * `error instanceof Error ? error.message : …` was empty or carried the whole statement, and the
 * duplicate-key checks written that way answered every in-game duplicate as "Something went
 * wrong" (7dee7385). Every site now reads `reasonOf`; the scan below keeps a new one out.
 */

const ROOT = join(__dirname, '..', '..');

describe('reasonOf', () => {
  it("reads this realm's Error", () => {
    expect(reasonOf(new Error('connection lost'))).toBe('connection lost');
  });

  it("reads oxmysql's rejection, built in another realm, to the driver's line alone", () => {
    const thrown = oxmysqlRejection(
      'INSERT INTO `mica_messages` (`message`) VALUES (?)',
      ['a private body'],
      duplicateEntry('7-a', 'pair_key')
    );
    expect(thrown instanceof Error).toBe(false);
    expect(reasonOf(thrown)).toBe("Duplicate entry '7-a' for key 'pair_key'");
  });

  it('answers nothing, never the parameters, when the driver said nothing', () => {
    const thrown = oxmysqlRejection('INSERT …', ['a private body'], '');
    expect(reasonOf(thrown)).toBe('');
  });

  it('reads a string, to its last line', () => {
    expect(reasonOf('timed out')).toBe('timed out');
    expect(reasonOf('first\nsecond\n\n')).toBe('second');
  });

  it('answers nothing for undefined and null', () => {
    expect(reasonOf(undefined)).toBe('');
    expect(reasonOf(null)).toBe('');
  });

  it('survives a value with no toString', () => {
    expect(reasonOf(Object.create(null))).toBe('');
  });

  it('survives a message getter that throws, since it is read inside a catch', () => {
    const hostile = {
      get message(): string {
        throw new Error('no');
      }
    };
    expect(() => reasonOf(hostile)).not.toThrow();
    expect(reasonOf(hostile, NO_REASON)).toBe(NO_REASON);
  });

  it('says nothing for a plain object, rather than "[object Object]"', () => {
    expect(reasonOf({ code: 'ECONNREFUSED' })).toBe('');
  });

  /**
   * Node's dual-stack ECONNREFUSED is an AggregateError with `message: ''`, so oxmysql's last
   * line is the parameters. A caller that would print "failed: " and nothing passes a fallback.
   */
  it('answers the fallback, never the parameters, when there is no line to give', () => {
    const thrown = oxmysqlRejection('SELECT …', ['a private body'], '');
    expect(reasonOf(thrown, NO_REASON)).toBe(NO_REASON);
    expect(reasonOf(new Error(''), NO_REASON)).toBe(NO_REASON);
    expect(reasonOf(new Error('connection lost'), NO_REASON)).toBe('connection lost');
  });
});

// ─── the guard ───────────────────────────────────────────────────────────────────────────────

interface Finding {
  file: string;
  line: number;
  text: string;
}

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node);

/** Whether `scope` reads `.message` off an expression spelled `subject`. */
const readsMessageOf = (scope: ts.Node, subject: string): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'message' &&
      node.expression.getText() === subject
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
};

/**
 * Every `x instanceof Error` whose enclosing function also reads `x.message` — off the AST, so
 * the words in a comment or a string do not count, and `!(x instanceof Error)` followed by a
 * read of `x.message` lines later does.
 */
const instanceofMessageReads = (text: string, file: string): Finding[] => {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const visit = (node: ts.Node, scope: ts.Node): void => {
    const inner = isFunctionLike(node) ? node : scope;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(node.right) &&
      node.right.text === 'Error' &&
      readsMessageOf(scope, node.left.getText())
    ) {
      out.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.getText()
      });
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sourceFile, sourceFile);
  return out;
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });

describe('no reason read through instanceof Error', () => {
  it('finds the shapes it is for', () => {
    const planted = [
      'const a = (error: unknown) => (error instanceof Error ? error.message : String(error));',
      'function b(err: unknown) {',
      '  if (!(err instanceof Error)) return String(err);',
      '  return err.message;',
      '}',
      'const c = (e: unknown) => {',
      '  const cause = (e as { cause?: unknown }).cause;',
      '  return cause instanceof Error ? cause.message.split("\\n").pop() : "";',
      '};'
    ].join('\n');
    expect(instanceofMessageReads(planted, 'planted.ts').map((f) => f.line)).toEqual([1, 3, 8]);
  });

  it('passes what the guard does not mean', () => {
    const fine = [
      '// error instanceof Error ? error.message : String(error) — in a comment',
      "const s = 'error instanceof Error ? error.message : x';",
      'const a = (error: unknown) => reasonOf(error);',
      'const b = (error: unknown, other: { message: string }) =>',
      '  error instanceof Error ? other.message : "";'
    ].join('\n');
    expect(instanceofMessageReads(fine, 'fine.ts')).toEqual([]);
  });

  it('holds every file under server/, so a new one cannot come back', () => {
    const files = walk(join(ROOT, 'server'));
    // A walk that found nothing would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((full) =>
      instanceofMessageReads(readFileSync(full, 'utf8'), relative(ROOT, full).split('\\').join('/'))
    );
    expect(
      found.map(({ file, line, text }) => `${file}:${line} ${text} — use reasonOf (sqlErrors.ts)`)
    ).toEqual([]);
  });
});
