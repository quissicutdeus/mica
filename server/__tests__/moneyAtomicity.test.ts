// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
/**
 * Root's own `typescript` is pinned to 7.x (AGENTS.md §3) and ships with no stable
 * programmatic compiler API until 7.1 — `createSourceFile`, `forEachChild` and the
 * `isXxx` guards are all `undefined` on it today. `web/` already carries 6.0.3 as a real
 * devDependency for `svelte-check`, so this pulls that exact version in under an alias
 * (`typescript-ast-parser` in `package.json`) rather than adding a second parsing library
 * or reaching across the workspace boundary into `web/node_modules` by a relative path.
 * Parsing only — nothing here type-checks, so the version split in §3 is untouched.
 */
import * as ts from 'typescript-ast-parser';

/**
 * MICA-134. Money moves in exactly two places that decide anything — `Payments.transfer`
 * and Hodlr's `buy`/`sell` — and each is safe for the same reason: the balance check and the
 * debit/credit it gates run in one synchronous span, so nothing can interleave between
 * deciding and acting. That is true because neither span contains an `await`, not because of
 * any SQL predicate — gOS owns no money table, and the framework's own atomic decrement
 * was considered and rejected (`Payments.ts:108-112`: frameworks disagree about whether an
 * overdraw refuses or clamps, so the affordability decision does not belong to the framework).
 *
 * That invariant is unenforced today. A future `await someAsyncCall()` slipped between a
 * `getMoney` check and the `removeMoney`/`addMoney` it gates reopens a double-spend class
 * with every other gate green — nothing type-checks server code (§3) and nothing else here
 * would notice. This is the native idiom for that shape of rule (`eventNames.test.ts`,
 * `convars.test.ts`): scan the source rather than trust a comment to stay true.
 *
 * **Why the AST rather than a regex.** A string literal containing the word `await`, or a
 * money call sitting inside a nested closure, would fool a token scan into a false positive
 * or a false negative respectively. The TypeScript parser is the only thing that actually
 * knows where a function ends and whether a token is code or text.
 */

const ROOT = join(__dirname, '..', '..');

/**
 * Every file allowed to call `getMoney`/`removeMoney`/`addMoney` at all — the shape of
 * `reachability.test.ts`'s registered-action allowlist, applied to a different kind of
 * reachable surface. A money call anywhere else is invisible to every other gate here, so
 * a new one has to be a deliberate addition to this list, not a silent accretion.
 */
const ALLOWED_MONEY_FILES = new Set([
  'server/lib/Payments.ts',
  'server/services/Hodlr.ts',
  /**
   * Implements `FrameworkPlayer.getMoney`/`removeMoney`/`addMoney` over qb and ESX, and reads
   * the raw ESX `xPlayer.getMoney()` once while computing a pre-account cash balance.
   * Plumbing, not a caller deciding to move money — `Payments.ts` and `Hodlr.ts` are the only
   * two that do that.
   *
   * One entry per adapter since MICA-197 split the bridge by framework. Listed by name
   * rather than by a `server/lib/framework/` prefix rule, deliberately: a new framework's
   * file should have to be added here by whoever writes it, which is the moment to notice
   * that it is about to move money.
   */
  'server/lib/FrameworkBridge.ts',
  'server/lib/framework/esx.ts',
  'server/lib/framework/qb.ts',
  'server/lib/framework/qbx.ts',
  'server/lib/framework/standalone.ts'
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__tests__']);

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
};

const MONEY_METHODS = new Set(['getMoney', 'removeMoney', 'addMoney']);

const isMoneyCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  MONEY_METHODS.has(node.expression.name.text);

type FunctionWithBlockBody = (
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
) & { body: ts.Block };

const isFunctionWithBlockBody = (node: ts.Node): node is FunctionWithBlockBody =>
  (ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)) &&
  !!node.body &&
  ts.isBlock(node.body);

interface ParsedFile {
  file: string;
  sourceFile: ts.SourceFile;
}

const parse = (absPath: string): ParsedFile => ({
  file: relative(ROOT, absPath),
  sourceFile: ts.createSourceFile(
    absPath,
    readFileSync(absPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
});

/** Every function-like node with a block body, anywhere in the file — nested ones included. */
const functionsIn = (sourceFile: ts.SourceFile): FunctionWithBlockBody[] => {
  const found: FunctionWithBlockBody[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionWithBlockBody(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
};

/**
 * Every money call and await inside one function, without wandering into a nested
 * function's own scope — a closure passed to `.then()` or similar has its own turn as an
 * entry in `functionsIn`, and folding its calls into the outer function would blame the
 * wrong span for an await that belongs to a different task entirely.
 *
 * `topLevelMoneyCalls` deliberately excludes a money call sitting inside a *nested block*
 * of this same function — an `if`/`try` body one level deeper than the function's own top
 * statement list. That is what a compensating action looks like: `Payments.transfer`'s
 * refund and `Hodlr.buy`'s coin-credit refund are both exactly one block deeper than the
 * balance check and the debit they follow, because both run only once an earlier step has
 * already failed. They are a later, independent decision, not part of the span that must
 * not yield — the money has already correctly moved by the time either runs. Restricting
 * to the function's own top-level block is what keeps the span to the check-then-act pair
 * the invariant is actually about, and it is why `Hodlr.buy`'s pre-existing `await` before
 * its first money call, and the one between its debit and its coin-credit persistence, both
 * fall outside the span this test asserts on.
 */
const scanFunction = (
  fn: FunctionWithBlockBody
): { topLevelMoneyCalls: ts.CallExpression[]; awaits: ts.AwaitExpression[] } => {
  const bodyBlock = fn.body;
  const topLevelMoneyCalls: ts.CallExpression[] = [];
  const awaits: ts.AwaitExpression[] = [];

  const visit = (node: ts.Node, nearestBlock: ts.Block) => {
    if (node !== fn && isFunctionWithBlockBody(node)) return;
    if (isMoneyCall(node) && nearestBlock === bodyBlock) topLevelMoneyCalls.push(node);
    if (ts.isAwaitExpression(node)) awaits.push(node);
    const childBlock = ts.isBlock(node) ? node : nearestBlock;
    ts.forEachChild(node, (child) => visit(child, childBlock));
  };

  ts.forEachChild(bodyBlock, (child) => visit(child, bodyBlock));
  return { topLevelMoneyCalls, awaits };
};

const MONEY_FILES = [
  'server/lib/Payments.ts',
  'server/services/Hodlr.ts',
  'server/lib/FrameworkBridge.ts'
].map((rel) => parse(join(ROOT, rel)));

describe('money calls are confined to a named allowlist of files', () => {
  it('finds money calls to check at all', () => {
    // Guards the scan itself: a matcher that silently stops matching would let every other
    // assertion in this file pass vacuously.
    const total = MONEY_FILES.reduce(
      (sum, { sourceFile }) =>
        sum +
        functionsIn(sourceFile).reduce(
          (n, fn) => n + scanFunction(fn).topLevelMoneyCalls.length,
          0
        ),
      0
    );
    expect(total).toBeGreaterThan(0);
  });

  it('every getMoney/removeMoney/addMoney call site is in a file on the allowlist', () => {
    const offenders: string[] = [];
    for (const dir of ['server']) {
      for (const absPath of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, absPath);
        if (ALLOWED_MONEY_FILES.has(rel)) continue;
        const { sourceFile } = parse(absPath);
        let hasMoneyCall = false;
        const visit = (node: ts.Node) => {
          if (isMoneyCall(node)) hasMoneyCall = true;
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile, visit);
        if (hasMoneyCall) offenders.push(rel);
      }
    }
    expect(
      offenders,
      'add the file to ALLOWED_MONEY_FILES, deliberately, or move the call'
    ).toEqual([]);
  });
});

describe('a balance check and the debit/credit it gates never span an await', () => {
  /**
   * The self-check `reachability.test.ts` and `netGuardCensus.test.ts` both carry: a
   * matcher that quietly stops matching reads as a pass, which is the exact "a check that
   * stays silent when it cannot run is worse than no check" shape AGENTS.md names.
   *
   * `topLevelMoneyCalls` is deliberately block-scoped so a compensating refund one level
   * deeper does not false-positive (see `scanFunction`'s doc comment) — but that scoping
   * has an edge the two tests above do not cover. If a future edit ever wraps a *real*
   * check-then-act pair in a nested block of its own — a `try` around the debit, say, the
   * same shape `Hodlr.buy`'s coin-credit persistence already uses two lines below its
   * debit — both calls drop out of `topLevelMoneyCalls` together, that function's count
   * falls under 2, and the `it.each` below silently `continue`s past it with no failure.
   * Nothing regresses today, so this passes — but it is what makes tomorrow's silent skip
   * fail loud instead. Exactly two functions qualify right now, `Payments.transfer` and
   * `Hodlr.buy`; a floor of 2 catches either one dropping out without pinning the total so
   * tightly that a legitimate third money-moving function has to edit this number too.
   */
  it('checks at least two functions where the invariant actually applies', () => {
    const qualifying = MONEY_FILES.flatMap(({ sourceFile }) =>
      functionsIn(sourceFile).filter((fn) => scanFunction(fn).topLevelMoneyCalls.length >= 2)
    );

    expect(qualifying.length).toBeGreaterThanOrEqual(2);
  });

  it.each(MONEY_FILES)('$file', ({ file, sourceFile }) => {
    for (const fn of functionsIn(sourceFile)) {
      const { topLevelMoneyCalls, awaits } = scanFunction(fn);
      if (topLevelMoneyCalls.length < 2) continue; // nothing to race against

      const spanStart = topLevelMoneyCalls[0].getStart(sourceFile);
      const spanEnd = topLevelMoneyCalls[topLevelMoneyCalls.length - 1].getEnd();

      const yielding = awaits.filter((a) => {
        const pos = a.getStart(sourceFile);
        return pos > spanStart && pos < spanEnd;
      });

      expect(
        yielding.length,
        `${file}: an await sits between the first and last top-level money call in a ` +
          `function starting at line ${sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line + 1} — ` +
          'that reopens the race the balance check exists to close.'
      ).toBe(0);
    }
  });
});
