// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript-ast-parser';

/**
 * The list of what the client may decide for itself, held to the code (MICA-468).
 *
 * `docs/security.md` § "Client-authoritative values" is the whole list, and its rule is that the
 * default is server-authoritative: anything the client owns needs a reason it _cannot_ move.
 * Battery charge and signal bars were both on it and both moved. Nothing failed when either was
 * added, and nothing would fail if the server started believing a third value. This suite is
 * that failure, in three parts:
 *
 * 1. **The list as documented.** The section's `###` entries are parsed and pinned below, so an
 *    entry added to the doc is a one-line edit here in the same commit — a decision a reviewer
 *    sees, not a paragraph that slipped in.
 * 2. **The set as the code has it.** Derived, never listed: every handler a client reaches is
 *    followed, by its AST, from the parameters the client wrote into every write of state a
 *    module holds between events. What lands there and is not a judged request below is a value
 *    the client decides — named by the exported reader that answers from it.
 * 3. **The one held to the other.** Every derived value must be on the documented list.
 *
 * **Two halves, because the documented entry lives on the client.** `DeviceState.isTyping` never
 * reaches the server: the page sends `setTyping` to the client (`client/client.ts`), which keeps
 * it in `client/lib/DeviceState.ts` and reads it in `DeviceVisibility.ts` to keep a keybind from
 * firing while a field has focus. So the derivation runs on both boundaries a modified player
 * can drive — a net event or endpoint action into the server, and a NUI callback into the client.
 *
 * **Why the AST.** `moneyAtomicity.test.ts` has the reasoning: only the parser knows where a
 * function ends and whether a token is code. It is the same `typescript-ast-parser` alias, for
 * parsing only, so the version split in AGENTS.md §3 is untouched.
 */

const ROOT = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------------------------

/** A file read once: its top-level declarations, and where each imported name comes from. */
interface Module {
  file: string;
  rel: string;
  source: ts.SourceFile;
  /** Every top-level `const`/`let`/`var`/`function` name, to its declaration. */
  decls: Map<string, ts.Node>;
  /** Top-level names that are exported. */
  exported: Set<string>;
  imports: Map<string, { file: string; name: string }>;
}

const modules = new Map<string, Module | null>();

const resolveImport = (from: string, spec: string): string | null => {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@mica/shared/')) base = join(ROOT, 'shared', spec.slice(13));
  else return null;
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const hasExport = (node: ts.Node): boolean =>
  (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword
  );

function loadModule(file: string): Module | null {
  if (modules.has(file)) return modules.get(file) ?? null;
  if (!existsSync(file)) {
    modules.set(file, null);
    return null;
  }
  return parseModule(file, readFileSync(file, 'utf8'));
}

/** Parse `text` as the module at `file`, and remember it under that path. */
function parseModule(file: string, text: string): Module {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const mod: Module = {
    file,
    rel: relative(ROOT, file).split('\\').join('/'),
    source,
    decls: new Map(),
    exported: new Set(),
    imports: new Map()
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        for (const name of bindingNames(decl.name)) {
          mod.decls.set(name, decl);
          if (hasExport(statement)) mod.exported.add(name);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      mod.decls.set(statement.name.text, statement);
      if (hasExport(statement)) mod.exported.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      mod.decls.set(statement.name.text, statement);
      if (hasExport(statement)) mod.exported.add(statement.name.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      // `export { a, b as c } from './x'` and `export { a }`: resolvable by the exported name.
      const target = statement.moduleSpecifier
        ? ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveImport(file, statement.moduleSpecifier.text)
          : null
        : null;
      for (const element of statement.exportClause.elements) {
        const inner = (element.propertyName ?? element.name).text;
        mod.exported.add(element.name.text);
        if (target) mod.imports.set(element.name.text, { file: target, name: inner });
        else if (inner !== element.name.text && !mod.imports.has(element.name.text)) {
          const local = mod.decls.get(inner);
          if (local) mod.decls.set(element.name.text, local);
        }
      }
    } else if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      const target = resolveImport(file, statement.moduleSpecifier.text);
      if (!target) continue;
      for (const element of statement.importClause.namedBindings.elements) {
        mod.imports.set(element.name.text, {
          file: target,
          name: (element.propertyName ?? element.name).text
        });
      }
    }
  }
  modules.set(file, mod);
  return mod;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

const isFn = (node: ts.Node | undefined): node is Fn =>
  !!node &&
  (ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node));

/** A top-level name as a function, following one import hop. */
function functionNamed(mod: Module, name: string): { mod: Module; fn: Fn } | null {
  const local = mod.decls.get(name);
  if (local) {
    if (isFn(local)) return { mod, fn: local };
    if (ts.isVariableDeclaration(local) && isFn(local.initializer)) {
      return { mod, fn: local.initializer };
    }
    return null;
  }
  const imported = mod.imports.get(name);
  if (!imported) return null;
  const target = loadModule(imported.file);
  return target ? functionNamed(target, imported.name) : null;
}

/** A top-level `const X = { … }` or `class X`, as the module that holds it and the declaration. */
type Holder = ts.ObjectLiteralExpression | ts.ClassDeclaration;

function objectNamed(mod: Module, name: string): { mod: Module; holder: Holder } | null {
  const local = mod.decls.get(name);
  if (local) {
    if (ts.isClassDeclaration(local)) return { mod, holder: local };
    if (
      ts.isVariableDeclaration(local) &&
      local.initializer &&
      ts.isObjectLiteralExpression(local.initializer)
    ) {
      return { mod, holder: local.initializer };
    }
    return null;
  }
  const imported = mod.imports.get(name);
  if (!imported) return null;
  const target = loadModule(imported.file);
  return target ? objectNamed(target, imported.name) : null;
}

/** A literal's function-valued property, or a class's method (static or not), by name. */
const memberFn = (holder: Holder, name: string): Fn | null => {
  const members: readonly ts.Node[] = ts.isClassDeclaration(holder)
    ? holder.members
    : holder.properties;
  for (const member of members) {
    const named = member as ts.Node & { name?: ts.PropertyName };
    if (!named.name || !ts.isIdentifier(named.name) || named.name.text !== name) continue;
    if (ts.isMethodDeclaration(member)) return member;
    if (
      (ts.isPropertyAssignment(member) || ts.isPropertyDeclaration(member)) &&
      isFn(member.initializer)
    ) {
      return member.initializer;
    }
  }
  return null;
};

/** A top-level declaration by name, following imports, with the module that holds it. */
function declNamed(mod: Module, name: string): { mod: Module; decl: ts.Node } | null {
  const local = mod.decls.get(name);
  if (local) return { mod, decl: local };
  const imported = mod.imports.get(name);
  const target = imported ? loadModule(imported.file) : null;
  return target && imported ? declNamed(target, imported.name) : null;
}

/**
 * A name declared inside the functions around `node`, innermost first: a nested function it can
 * open, or something it cannot — a parameter (a callback handed in) or a local value. `null` when
 * nothing inside a function declares it, so the name is the module's or a global.
 */
function localBinding(node: ts.Node, name: string): { fn: Fn } | { kind: string } | null {
  for (let at: ts.Node | undefined = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (isFn(at) || ts.isConstructorDeclaration(at)) {
      for (const parameter of at.parameters) {
        if (!bindingNames(parameter.name).includes(name)) continue;
        // `new Promise((resolve, reject) => …)`: the built-in's own settle functions.
        const executor =
          ts.isNewExpression(at.parent) &&
          ts.isIdentifier(at.parent.expression) &&
          at.parent.expression.text === 'Promise';
        return { kind: executor ? PROMISE_SETTLE : 'a parameter' };
      }
    }
    if (ts.isBlock(at) || ts.isCaseClause(at) || ts.isDefaultClause(at)) {
      for (const statement of at.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
          return { fn: statement };
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (!bindingNames(decl.name).includes(name)) continue;
          return ts.isIdentifier(decl.name) && isFn(decl.initializer)
            ? { fn: decl.initializer }
            : { kind: 'a local value' };
        }
      }
    }
  }
  return null;
}

const PROMISE_SETTLE = 'a Promise settle function';

/** A class's field or getter by name, or its base class's, with the module that holds it. */
function fieldOf(
  mod: Module,
  cls: ts.ClassDeclaration,
  name: string,
  depth = 0
): { mod: Module; node: ts.PropertyDeclaration | ts.GetAccessorDeclaration } | null {
  for (const member of cls.members) {
    if (
      (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
      member.name.getText() === name
    ) {
      return { mod, node: member };
    }
  }
  if (depth > 8) return null;
  for (const clause of cls.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      if (!ts.isIdentifier(type.expression)) continue;
      const base = objectNamed(mod, type.expression.text);
      if (base && ts.isClassDeclaration(base.holder)) {
        const found = fieldOf(base.mod, base.holder, name, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

const BUILT_IN_TYPES = new Set(['Array', 'ReadonlyArray', 'Map', 'Set', 'WeakMap', 'WeakSet']);

/**
 * A field that holds a value rather than a collaborator: an array, a literal, or a built-in
 * collection, by its type or its initializer. A method on it is the value's, not tree code.
 */
function isValueField(
  mod: Module,
  node: ts.PropertyDeclaration | ts.GetAccessorDeclaration
): boolean {
  let type = node.type;
  if (type && ts.isTypeOperatorNode(type)) type = type.type;
  if (type && ts.isArrayTypeNode(type)) return true;
  if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    if (BUILT_IN_TYPES.has(type.typeName.text)) return true;
  }
  const init = ts.isPropertyDeclaration(node) ? node.initializer : undefined;
  if (!init) return false;
  if (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init)) return true;
  if (ts.isStringLiteral(init) || ts.isNumericLiteral(init)) return true;
  return (
    ts.isNewExpression(init) &&
    ts.isIdentifier(init.expression) &&
    !objectNamed(mod, init.expression.text)
  );
}

/** Source text with its line breaks and indentation folded, so a pin is one line. */
const oneLine = (node: ts.Node): string => node.getText().replace(/\s+/g, '');

/** A class's method by name, or its base class's (`extends`), with the module that holds it. */
function methodOf(
  mod: Module,
  cls: ts.ClassDeclaration,
  name: string,
  depth = 0
): { mod: Module; fn: Fn } | null {
  const own = memberFn(cls, name);
  if (own) return { mod, fn: own };
  if (depth > 8) return null;
  for (const clause of cls.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      if (!ts.isIdentifier(type.expression)) continue;
      const base = objectNamed(mod, type.expression.text);
      if (base && ts.isClassDeclaration(base.holder)) {
        const found = methodOf(base.mod, base.holder, name, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** The tree classes a type annotation names (`Repo | null` names `Repo`). */
function classesIn(
  mod: Module,
  type: ts.TypeNode | undefined
): { mod: Module; cls: ts.ClassDeclaration }[] {
  if (!type) return [];
  if (ts.isUnionTypeNode(type)) return type.types.flatMap((member) => classesIn(mod, member));
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const found = objectNamed(mod, type.typeName.text);
    return found && ts.isClassDeclaration(found.holder)
      ? [{ mod: found.mod, cls: found.holder }]
      : [];
  }
  return [];
}

/** `method` on whatever a declared type names, or why not. */
function viaType(mod: Module, type: ts.TypeNode | undefined, method: string): Callee | undefined {
  for (const { mod: at, cls } of classesIn(mod, type)) {
    const found = methodOf(at, cls, method);
    if (found) return found;
  }
  return undefined;
}

const enclosingClass = (node: ts.Node): ts.ClassDeclaration | null => {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isClassDeclaration(at)) return at;
  }
  return null;
};

/**
 * What a call names: a function in the tree to follow, one the tree defines but this cannot
 * open (`unopened`, with why), or `null` — a native, a JavaScript built-in, or a method on a value
 * the function holds (`payload.trim()`, a `Map`'s `get`), none of which is tree code.
 */
type Callee = { mod: Module; fn: Fn } | { unopened: string } | null;

function calleeOf(mod: Module, call: ts.CallExpression): Callee {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const local = localBinding(call, callee.text);
    if (local && 'fn' in local) return { mod, fn: local.fn };
    if (local) {
      return local.kind === PROMISE_SETTLE ? null : { unopened: `${callee.text}: ${local.kind}` };
    }
    const named = functionNamed(mod, callee.text);
    if (named) return named;
    // Declared or imported, and still not a function: a late-bound slot or a built one.
    if (mod.decls.has(callee.text) || mod.imports.has(callee.text)) {
      return { unopened: `${callee.text}: a slot or a function built by a call` };
    }
    return null;
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    const root = rootOf(callee);
    return root && (mod.decls.has(root) || mod.imports.has(root))
      ? { unopened: `${oneLine(callee)}: a computed callee` }
      : null;
  }
  const method = callee.name.text;
  const receiver = callee.expression;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
    const cls = enclosingClass(call);
    return (
      (cls && methodOf(mod, cls, method)) ?? { unopened: `this.${method}: no method of the class` }
    );
  }
  if (ts.isIdentifier(receiver)) {
    if (localBinding(call, receiver.text)) return null;
    const holder = objectNamed(mod, receiver.text);
    if (holder) {
      const fn = memberFn(holder.holder, method);
      return fn ? { mod: holder.mod, fn } : { unopened: `${oneLine(callee)}: no such member` };
    }
    const found = declNamed(mod, receiver.text);
    if (!found || !ts.isVariableDeclaration(found.decl)) return null;
    const typed = viaType(found.mod, found.decl.type, method);
    if (typed) return typed;
    const init = found.decl.initializer;
    if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
      const cls = objectNamed(found.mod, init.expression.text);
      if (!cls) return null; // `new Map()`, `new Set()`: a built-in's method.
      const found2 = ts.isClassDeclaration(cls.holder)
        ? methodOf(cls.mod, cls.holder, method)
        : (() => {
            const fn = memberFn(cls.holder, method);
            return fn ? { mod: cls.mod, fn } : null;
          })();
      return found2 ?? { unopened: `${oneLine(callee)}: no such method` };
    }
    // A module binding with no initializer, `null`, or a call's answer: an instance of a class
    // nothing here names (a repository built at start-up).
    const opaque =
      !init ||
      init.kind === ts.SyntaxKind.NullKeyword ||
      ts.isCallExpression(init) ||
      ts.isAwaitExpression(init);
    return opaque && !MUTATORS.has(method)
      ? { unopened: `${oneLine(callee)}: an instance of no class the tree names` }
      : null;
  }
  // `this.repository.update(…)`: a method on an instance field, unless the class fills that
  // field with a built-in (`this.phoneRequired = new Set()`). Any other member of a member —
  // `DEVICES[d].label.toLowerCase()`, `Database.oxmysql.query_async(…)`, a call's answer — is a
  // method on a value or on another resource, not tree code.
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const cls = enclosingClass(call);
    const member = cls ? fieldOf(mod, cls, receiver.name.text) : null;
    const typed = member ? viaType(member.mod, member.node.type, method) : undefined;
    if (typed) return typed;
    return member && isValueField(member.mod, member.node)
      ? null
      : { unopened: `${oneLine(callee)}: an instance field` };
  }
  return null;
}

/** An identifier used as a value, not as a property name or a declaration's name. */
const isReference = (id: ts.Identifier): boolean => {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  return true;
};

const mentions = (node: ts.Node, names: ReadonlySet<string>): boolean => {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(child) && names.has(child.text) && isReference(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

/**
 * The module-scope name a write lands in: `held` for `held.set(…)`, `held[k] = …` and
 * `held = …`; `entry().open` for `entry(id).open = …`, where `entry` is the module's own
 * accessor for its table. `null` when the target is local to a function.
 */
function stateOf(mod: Module, target: ts.Expression, locals: ReadonlySet<string>): string | null {
  let node: ts.Expression = target;
  let field: string | null = null;
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else if (ts.isPropertyAccessExpression(node)) {
      field = node.name.text;
      node = node.expression;
    } else if (ts.isElementAccessExpression(node)) {
      field = null;
      node = node.expression;
    } else break;
  }
  if (ts.isIdentifier(node)) {
    return mod.decls.has(node.text) && !locals.has(node.text) ? node.text : null;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const accessor = node.expression.text;
    if (!mod.decls.has(accessor) || locals.has(accessor)) return null;
    return field ? `${accessor}().${field}` : `${accessor}()`;
  }
  return null;
}

/** Methods that put something into a collection. */
const FILLERS = new Set(['set', 'add', 'push', 'unshift', 'splice', 'assign']);
/** Methods that take something out — but `delete` is also a repository's, so see `filled`. */
const REMOVERS = new Set(['delete', 'clear']);
const MUTATORS = new Set([...FILLERS, ...REMOVERS]);

const rootOf = (node: ts.Expression): string | null => {
  let at: ts.Expression = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(at) ||
      ts.isNonNullExpression(at) ||
      ts.isPropertyAccessExpression(at) ||
      ts.isElementAccessExpression(at) ||
      ts.isCallExpression(at)
    ) {
      at = at.expression;
    } else break;
  }
  return ts.isIdentifier(at) ? at.text : null;
};

const filledCache = new Map<Module, Set<string>>();

/**
 * The module-scope names this module ever fills with a `FILLERS` call — what makes a `delete` on
 * one a collection's rather than a repository's (`messageRepo.delete(…)` is a SQL statement).
 */
function filled(mod: Module): Set<string> {
  const cached = filledCache.get(mod);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      FILLERS.has(node.expression.name.text)
    ) {
      const root = rootOf(node.expression.expression);
      if (root) names.add(root);
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.source);
  filledCache.set(mod, names);
  return names;
}

/** A client-sent value written into state a module holds between events. */
interface Landing {
  mod: Module;
  state: string;
  /** The entry point it arrived through, as `<file>: <event>`. */
  via: string;
  /**
   * What the write is keyed by: the caller (`source`, or anything an endpoint is handed about
   * them: citizenid, player, device id), nothing (the whole binding is replaced, so every player
   * shares it), or anything else.
   */
  keyed: 'source' | 'whole' | 'other';
  /** Whether the value written mentions the payload, rather than the payload deciding the write. */
  explicit: boolean;
}

/** What one traversal noticed beside its landings: where it had to stop following. */
interface Trace {
  landings: Landing[];
  /** A tainted call to a name the tree defines that the resolver could not open. */
  unresolved: Set<string>;
  /** A path cut at the depth limit. */
  tooDeep: Set<string>;
}

const MAX_DEPTH = 24;

/** Statements that leave the enclosing function or loop on every path through them. */
const exits = (node: ts.Statement): boolean => {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isContinueStatement(node) || ts.isBreakStatement(node)) return true;
  if (ts.isBlock(node)) {
    const last = node.statements[node.statements.length - 1];
    return !!last && exits(last);
  }
  if (ts.isIfStatement(node)) {
    return !!node.elseStatement && exits(node.thenStatement) && exits(node.elseStatement);
  }
  return false;
};

/**
 * Follows the client's payload from `fn`'s tainted parameters into every write of module
 * state, through calls to functions this tree defines.
 *
 * - **Explicit flow.** A value computed from the payload is the payload: taint is by name and
 *   field-insensitive. A value the server re-derives (its own maps, the database, a native)
 *   never mentions a tainted name and is never followed.
 * - **Implicit flow.** A write the payload decides whether to make is the payload's too: one
 *   inside a branch whose condition mentions it, or after an early exit that does
 *   (`if (!enabled) return;`). The one condition that is not a decision is the guard's own
 *   verdict (`if (!guarded) return;`, `guardNetEvent`'s answer): it refuses the whole request
 *   rather than choosing what is stored, and counting it would make every raw handler's every
 *   write the client's.
 * - **Per source.** `sourced` is the caller's connection — FiveM's `source`, an endpoint
 *   handler's first parameter, and whatever is computed from them — so a landing can say
 *   whether the state it wrote is keyed by who sent it.
 */
function follow(
  mod: Module,
  fn: Fn,
  payloadParam: (index: number) => boolean,
  sourceParam: (index: number) => boolean,
  decided: boolean,
  via: string,
  trace: Trace,
  seen: Set<string>,
  depth = 0
): void {
  const flags = fn.parameters
    .map((_, i) => `${payloadParam(i) ? 'p' : '-'}${sourceParam(i) ? 's' : '-'}`)
    .join('');
  const key = `${mod.file}:${fn.pos}:${flags}:${decided}`;
  if (seen.has(key)) return;
  if (depth > MAX_DEPTH) {
    trace.tooDeep.add(`${via} -> ${mod.rel}:${fn.pos}`);
    return;
  }
  seen.add(key);
  if (!fn.body) return;

  const tainted = new Set<string>();
  const sourced = new Set<string>();
  const locals = new Set<string>();
  const verdicts = new Set<string>();
  fn.parameters.forEach((parameter, index) => {
    for (const name of bindingNames(parameter.name)) {
      locals.add(name);
      if (payloadParam(index)) tainted.add(name);
      if (sourceParam(index)) sourced.add(name);
    }
  });
  const declare = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name)) locals.add(name);
      if (ts.isIdentifier(node.name) && node.initializer && isGuardCall(node.initializer)) {
        verdicts.add(node.name.text);
      }
    }
    if (ts.isParameter(node)) for (const name of bindingNames(node.name)) locals.add(name);
    ts.forEachChild(node, declare);
  };
  declare(fn.body);
  // FiveM's `source` global, unless something here shadows it.
  if (!locals.has('source')) sourced.add('source');

  // To a fixpoint: a later declaration can feed an earlier closure.
  const spreadInto = (into: Set<string>): void => {
    for (let grew = true; grew;) {
      grew = false;
      const spread = (node: ts.Node): void => {
        let names: string[] = [];
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          mentions(node.initializer, into)
        ) {
          names = bindingNames(node.name);
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          locals.has(node.left.text) &&
          mentions(node.right, into)
        ) {
          names = [node.left.text];
        } else if (
          (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
          mentions(node.expression, into) &&
          ts.isVariableDeclarationList(node.initializer)
        ) {
          names = node.initializer.declarations.flatMap((d) => bindingNames(d.name));
        }
        for (const name of names) {
          if (!into.has(name)) {
            into.add(name);
            grew = true;
          }
        }
        ts.forEachChild(node, spread);
      };
      spread(fn.body!);
    }
  };
  spreadInto(tainted);
  spreadInto(sourced);

  /** A condition that decides something, as opposed to the guard's verdict on the whole request. */
  const decides = (condition: ts.Expression): boolean => {
    let bare: ts.Expression = condition;
    while (ts.isPrefixUnaryExpression(bare) || ts.isParenthesizedExpression(bare)) {
      bare = ts.isParenthesizedExpression(bare) ? bare.expression : bare.operand;
    }
    if (isGuardCall(bare)) return false;
    if (ts.isIdentifier(bare) && verdicts.has(bare.text)) return false;
    return mentions(condition, tainted);
  };

  const land = (
    target: ts.Expression,
    keyed: ts.Node | null,
    explicit: boolean,
    whole = false
  ): void => {
    const state = stateOf(mod, target, locals);
    if (!state) return;
    const by = !keyed ? 'other' : mentions(keyed, sourced) ? 'source' : 'other';
    trace.landings.push({ mod, state, via, keyed: whole ? 'whole' : by, explicit });
  };

  const visit = (node: ts.Node, pc: boolean): void => {
    if (ts.isIfStatement(node)) {
      const inner = pc || decides(node.expression);
      visit(node.expression, pc);
      visit(node.thenStatement, inner);
      if (node.elseStatement) visit(node.elseStatement, inner);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      const inner = pc || decides(node.condition);
      visit(node.condition, pc);
      visit(node.whenTrue, inner);
      visit(node.whenFalse, inner);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken
      ].includes(node.operatorToken.kind)
    ) {
      visit(node.left, pc);
      visit(node.right, pc || decides(node.left));
      return;
    }
    if (ts.isSwitchStatement(node)) {
      const inner = pc || decides(node.expression);
      visit(node.expression, pc);
      for (const clause of node.caseBlock.clauses) visit(clause, inner);
      return;
    }
    if (
      ts.isBlock(node) ||
      ts.isSourceFile(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      let inner = pc;
      for (const statement of node.statements) {
        visit(statement, inner);
        if (
          ts.isIfStatement(statement) &&
          decides(statement.expression) &&
          exits(statement.thenStatement)
        ) {
          inner = true;
        }
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const index = ts.isElementAccessExpression(node.left) ? node.left.argumentExpression : null;
      const accessor =
        ts.isPropertyAccessExpression(node.left) && ts.isCallExpression(node.left.expression)
          ? node.left.expression
          : null;
      const explicit = mentions(node.right, tainted) || (!!index && mentions(index, tainted));
      if (pc || explicit) land(node.left, index ?? accessor, explicit, ts.isIdentifier(node.left));
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments;
      const hot = args.map((arg) => mentions(arg, tainted));
      const anyTainted = hot.some(Boolean);
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression : null;
      const mutates =
        !!method &&
        (FILLERS.has(method.name.text) ||
          (REMOVERS.has(method.name.text) && filled(mod).has(rootOf(method.expression) ?? '')));
      if ((pc || anyTainted) && method && mutates) {
        // A collection's key is `set`'s and `add`'s first argument; an array has none.
        const keyed = ['set', 'add', 'delete'].includes(method.name.text)
          ? (args[0] ?? null)
          : null;
        land(method.expression, keyed, anyTainted);
      }
      if (pc || anyTainted) {
        const target = calleeOf(mod, node);
        if (target && 'unopened' in target) {
          trace.unresolved.add(`${mod.rel}: ${target.unopened}`);
        } else if (target) {
          const warm = args.map((arg) => mentions(arg, sourced));
          const restAt = target.fn.parameters.findIndex((p) => !!p.dotDotDotToken);
          const at = (perArg: boolean[]) => (i: number) =>
            restAt >= 0 && i >= restAt ? perArg.slice(restAt).some(Boolean) : !!perArg[i];
          follow(target.mod, target.fn, at(hot), at(warm), pc, via, trace, seen, depth + 1);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, pc));
  };
  visit(fn.body, decided);
}

const isGuardCall = (node: ts.Expression): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'guardNetEvent';

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });

const literalText = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** Every call in a module that `pick` turns into an entry point. */
function entriesIn(
  file: string,
  pick: (mod: Module, call: ts.CallExpression) => Omit<Entry, 'mod'> | null
): Entry[] {
  const mod = loadModule(file);
  if (!mod) return [];
  const found: Entry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const entry = pick(mod, node);
      if (entry) found.push({ ...entry, mod });
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.source);
  return found;
}

/** The handler argument as a function: a literal, or a top-level function it names. */
const handlerOf = (mod: Module, arg: ts.Expression | undefined): Fn | null => {
  if (!arg) return null;
  if (isFn(arg)) return arg;
  if (ts.isIdentifier(arg)) return functionNamed(mod, arg.text)?.fn ?? null;
  return null;
};

/**
 * The server's client-reachable handlers: every `onNet` (a net event is a client's to send, all
 * of its arguments), every `registerEvent` (a custom endpoint action) and every
 * `registerGeneric` (`ServiceEndpoint`'s own generic CRUD). An endpoint handler's third
 * parameter is the payload. The rest are the server's own answers about the caller — `source`,
 * citizenid, player, device id — except the callback id, which is the client's but only ever
 * echoed back. A raw handler derives the same answers from `source`, so both kinds name the
 * caller the same way.
 */
const ENDPOINT_REGISTRARS = new Set(['registerEvent', 'registerGeneric']);
const ENDPOINT_CALLER_PARAMS = new Set([0, 3, 4, 5]);

const serverEntries = (files: readonly string[]): Entry[] =>
  files.flatMap((file) =>
    entriesIn(file, (mod, call) => {
      const callee = call.expression;
      if (ts.isIdentifier(callee) && callee.text === 'onNet') {
        const fn = handlerOf(mod, call.arguments[1]);
        const event = literalText(call.arguments[0]) ?? call.arguments[0]?.getText() ?? '?';
        return fn
          ? { fn, via: `${mod.rel}: ${event}`, payload: () => true, source: () => false }
          : null;
      }
      if (ts.isPropertyAccessExpression(callee) && ENDPOINT_REGISTRARS.has(callee.name.text)) {
        const fn = handlerOf(mod, call.arguments[1]);
        const action = literalText(call.arguments[0]) ?? call.arguments[0]?.getText() ?? '?';
        return fn
          ? {
              fn,
              via: `${mod.rel}: ${callee.name.text} ${action}`,
              payload: (i: number) => i === 2,
              source: (i: number) => ENDPOINT_CALLER_PARAMS.has(i)
            }
          : null;
      }
      return null;
    })
  );

/** The client's web-reachable handlers: every `on('__cfx_nui:…')`, whose first argument is the page's. */
const clientEntries = (files: readonly string[]): Entry[] =>
  files.flatMap((file) =>
    entriesIn(file, (mod, call) => {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== 'on') return null;
      const event = call.arguments[0];
      const name = event ? event.getText() : '';
      if (!name.includes('__cfx_nui:')) return null;
      const fn = handlerOf(mod, call.arguments[1]);
      return fn
        ? { fn, via: `${mod.rel}: ${name}`, payload: (i: number) => i === 0, source: () => false }
        : null;
    })
  );

interface Entry {
  mod: Module;
  fn: Fn;
  via: string;
  payload: (index: number) => boolean;
  source: (index: number) => boolean;
}

function traceAll(entries: Entry[]): Trace {
  const trace: Trace = { landings: [], unresolved: new Set(), tooDeep: new Set() };
  for (const entry of entries) {
    follow(entry.mod, entry.fn, entry.payload, entry.source, false, entry.via, trace, new Set());
  }
  return trace;
}

// ---------------------------------------------------------------------------------------------
// What is device state, and what each value is called
// ---------------------------------------------------------------------------------------------

/**
 * Which landings are a client deciding device state.
 *
 * **Server: state keyed by the caller**, or a binding replaced outright with the payload. Device
 * state is per caller: open, charge, bars and typing all mean "this player's device right now".
 * The caller is the same whichever way a handler learns it. A raw handler derives it from
 * `source`; an endpoint action is handed it as `source`, citizenid, player and device id. A key
 * computed from any of those counts. State keyed by a row id, a channel or nothing at all is a
 * player's data or a cache, which AGENTS.md §2.9 and `hostilePayloads.test.ts` hold to
 * ownership. A whole binding counts only when the payload is the value written. One the payload
 * merely decides to touch is a lazy cache (`contentCipher`'s keyring, `FrameworkBridge`'s
 * reseed clock), not the client's word.
 *
 * **Client: every landing.** The whole client is one player's machine, so there is no key to
 * tell it apart by.
 */
const isDeviceState = (side: 'server' | 'client', landing: Landing): boolean =>
  side === 'client' ||
  landing.keyed === 'source' ||
  (landing.keyed === 'whole' && landing.explicit);

const landingKey = (landing: Landing): string =>
  `${landing.mod.rel} ${landing.state} <- ${landing.via}`;

/** The binding a state names, and the field read off its accessor's answer, if any. */
const parseState = (state: string): { binding: string; field: string | null } => {
  const accessor = /^(\w+)\(\)(?:\.(\w+))?$/.exec(state);
  return accessor
    ? { binding: accessor[1] as string, field: accessor[2] ?? null }
    : { binding: state, field: null };
};

/** Whether `node` reads `state`: a reference that is neither assigned to nor mutated. */
function reads(node: ts.Node, state: string): boolean {
  const { binding, field } = parseState(state);
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(child) && child.text === binding && isReference(child)) {
      let use: ts.Node = child;
      if (field !== null) {
        const call = child.parent;
        const access = call?.parent;
        if (
          !call ||
          !ts.isCallExpression(call) ||
          call.expression !== child ||
          !access ||
          !ts.isPropertyAccessExpression(access) ||
          access.name.text !== field
        ) {
          return;
        }
        use = access;
      }
      const parent = use.parent;
      const assigned =
        ts.isBinaryExpression(parent) &&
        parent.left === use &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const mutated =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === use &&
        MUTATORS.has(parent.name.text) &&
        ts.isCallExpression(parent.parent);
      if (!assigned && !mutated) found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * A value by what answers from it: `<Module>.<export>` for an exported function, or
 * `<Object>.<member>` for a member of an exported object literal — the way the doc already names
 * `DeviceState.isTyping`. Test seams (`__`-prefixed) are not readers. State nothing exported
 * reads is named by its binding, so it still shows up rather than vanishing.
 */
function nameOf(landing: Landing): string[] {
  const { mod, state } = landing;
  const base = basename(mod.file, '.ts');
  const readers: string[] = [];
  for (const name of mod.exported) {
    const decl = mod.decls.get(name);
    if (!decl || name.startsWith('__')) continue;
    const fn = isFn(decl)
      ? decl
      : ts.isVariableDeclaration(decl) && isFn(decl.initializer)
        ? decl.initializer
        : null;
    if (fn) {
      if (reads(fn, state)) readers.push(`${base}.${name}`);
      continue;
    }
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isObjectLiteralExpression(decl.initializer)
    ) {
      for (const property of decl.initializer.properties) {
        if (!property.name || !ts.isIdentifier(property.name)) continue;
        if (property.name.text.startsWith('__')) continue;
        if (reads(property, state)) readers.push(`${name}.${property.name.text}`);
      }
    }
  }
  return readers.length > 0 ? readers.sort() : [`${base}.${state}`];
}

// ---------------------------------------------------------------------------------------------
// Decisions: what lands in per-source state and is a request, not the client's word
// ---------------------------------------------------------------------------------------------

/**
 * Landings that are device-shaped but are the server honouring a **request** it checks, not
 * believing an **observation** it cannot. Pinned exactly: a landing not here is a value the
 * client decides and must be on the documented list; an entry here that no longer lands fails
 * too, so the list cannot keep a stale excuse. Each `why` was read off the code it names.
 */
const JUDGED: Record<string, string> = {
  'server/lib/shell.ts refusalsLogged <- server/lib/shell.ts: PLAYER_LOADED_EVENTS.network':
    'a log-once throttle per connection; the identity comes from the connection, not the packet',
  'server/services/Battery.ts charge <- server/services/Battery.ts: mica:server:admin:setBattery':
    "the DevTools slider; `isAdmin(src)` refuses before `setBatteryLevel` — the admin's word",
  'server/services/Battery.ts phoneOf <- server/services/Battery.ts: mica:server:admin:setBattery':
    'the same admin-gated slider; which phone is charged is resolved by the server',
  'server/services/Battery.ts loadFailed <- server/services/Battery.ts: mica:server:admin:setBattery':
    "per-source bookkeeping the slider's charge path clears, after `isAdmin(src)`",
  'server/services/Battery.ts loadToken <- server/services/Battery.ts: mica:server:admin:setBattery':
    "per-source bookkeeping the slider's charge path clears, after `isAdmin(src)`",
  'server/services/Battery.ts staleIdentity <- server/services/Battery.ts: mica:server:admin:setBattery':
    "per-source bookkeeping the slider's charge path clears, after `isAdmin(src)`",
  'server/services/Music.ts broadcasts <- server/services/Music.ts: registerEvent broadcastStart':
    'a request to play: the link must parse as YouTube and `positionFrom` bounds the offset',
  'server/lib/speakerphone.ts speakers <- server/services/Phone.ts: registerEvent speaker':
    'a request: `setSpeaker` refuses unless the caller is a party to an answered call',
  'server/services/Phone.ts playerCalls <- server/services/Phone.ts: mica:server:phone:start':
    'a dial request; the number is held to `phoneNumber` and resolved to a target by the server',
  'server/services/Phone.ts keyCharacter <- server/services/Phone.ts: mica:server:phone:start':
    "the same call's bookkeeping: whose character placed it, read from the framework",
  "client/game/Freelook.ts Freelook <- client/client.ts: '__cfx_nui:toggleFreelook'":
    "the page choosing the client's camera mode; nothing reaches the server",
  "client/game/DeviceAnimation.ts DeviceAnimation <- client/client.ts: '__cfx_nui:onCameraApp'":
    "the page choosing the client's own prop animation; nothing reaches the server",
  "client/game/PhoneCamera.ts PhoneCamera <- client/client.ts: '__cfx_nui:onCameraApp'":
    "the page opening the client's own camera view; nothing reaches the server",
  "client/game/PhoneCamera.ts PhoneCamera <- client/services/Camera.ts: '__cfx_nui:flipCamera'":
    "the page flipping the client's own camera; nothing reaches the server",
  "client/lib/DeviceVisibility.ts awaitingFrame <- client/client.ts: '__cfx_nui:frameShown'":
    "the page saying it drew the frame: it only stops the open's deadline for releasing focus, so a forged one keeps the player's own focus held, as never sending `hideFrame` already does; nothing reaches the server",
  "client/services/Battery.ts level <- client/services/Battery.ts: '__cfx_nui:setBatteryLevel'":
    "the DevTools slider's local paint; the server re-checks the admin ace and its next push wins",
  'client/services/Relay.ts proxies <- client/services/Relay.ts: `__cfx_nui:${GENERIC_SERVICE_ACTION}`':
    'one transport per service name; the server answers what it is sent and re-checks it'
};

/**
 * State judged by what it **is**, whichever route reaches it: a counter, a guard, a log-once set
 * or a cache keyed by the caller's citizenid. None of them holds a value the client chose, so
 * every action that reaches one is excused at once, and a new route to it needs no new line.
 * Pinned like `JUDGED`: an entry nothing reaches any more fails.
 */
const JUDGED_STATE: Record<string, string> = {
  'server/lib/contentCipher.ts said': "`sayOnce`'s log-once set; holds log keys, not values",
  'server/lib/contentCipher.ts liveWidths': 'column widths, read from the database',
  'server/lib/contentCipher.ts widthRetryAt': 'when to ask the database for a width again',
  'server/lib/moderation.ts decisions': 'a per-row queue of moderation work, a promise chain',
  'server/lib/rateLimit.ts windows': "the limiter's own count of the caller's requests",
  'server/lib/statusWrites.ts told': 'a log-once set, keyed by job',
  'server/services/Casino.ts live':
    'a crash round the player bet on: the server draws the crash point and prices the cash-out',
  'server/services/Casino.ts bustedByTimer': "the same round, as the server's timer settled it",
  'server/services/Casino.ts starting': 'a count of crash starts still waiting on their insert',
  'server/services/Darkchat.ts failedJoins': 'the wrong-join-code counter, charged before the read',
  'server/services/Invoices.ts callbacks':
    "another resource's callbacks for an invoice, released when it is paid or declined",
  'server/services/Lockscreen.ts attempts': 'the wrong-passcode counter and its lockout',
  'server/services/PlacesLive.ts shares':
    "a request to share: the duration is one of `LIVE_SHARE_DURATIONS`, the position the server's read",
  'server/services/Privacy.ts inFlight': 'the one-at-a-time guard on an export or a delete'
};

/**
 * Every call the traversal reached with the payload in hand and could not open, with why: a
 * parameter (a callback handed in; `ServiceEndpoint.dispatch`'s `handler` is the action itself,
 * entered on its own as a `registerEvent`/`registerGeneric` entry), a slot filled at start-up
 * (`let forRequest = null`, then an `install…` call), a local value, a computed callee, or an
 * instance whose class nothing here names. A payload is not followed past one. Pinned exactly, so
 * a new unopenable call, or one the resolver stopped reading, fails here rather than reading as
 * "lands nowhere".
 *
 * Not on this list, by design: natives, JavaScript built-ins, `new Promise`'s settle functions,
 * and methods on a value the function holds (`payload.trim()`, a `Map`'s `get`, an array field's
 * `filter`, `DEVICES[d].label.toLowerCase()`), none of which is tree code.
 */
const UNOPENED = [
  'client/game/DeviceAnimation.ts: init: a parameter',
  'client/services/Battery.ts: cb: a parameter',
  'client/services/Call.ts: cb: a parameter',
  'client/services/Location.ts: cb: a parameter',
  'client/services/Relay.ts: cb: a parameter',
  'client/services/Relay.ts: hook: a local value',
  'server/lib/DiscordWebhook.ts: fetch: a slot or a function built by a call',
  'server/lib/DiscordWebhook.ts: fn: a parameter',
  'server/lib/FrameworkBridge.ts: activeAdapter: a slot or a function built by a call',
  'server/lib/FrameworkBridge.ts: servingGetPlayer: a slot or a function built by a call',
  'server/lib/FrameworkBridge.ts: servingListPlayers: a slot or a function built by a call',
  'server/lib/FrameworkBridge.ts: synthetic.player: an instance of no class the tree names',
  'server/lib/FrameworkBridge.ts: synthetic.sourceOf: an instance of no class the tree names',
  'server/lib/FrameworkBridge.ts: synthetic?.isAdmin: an instance of no class the tree names',
  'server/lib/ServiceEndpoint.ts: handler: a parameter',
  'server/lib/ServiceEndpoint.ts: lookup: a parameter',
  'server/lib/ServiceEndpoint.ts: reply: a parameter',
  'server/lib/ServiceEndpoint.ts: this.options.onAfterDelete: an instance field',
  'server/lib/addonServices.ts: handler: a local value',
  'server/lib/addonServices.ts: settle: a local value',
  'server/lib/appEvents.ts: deliver: a parameter',
  'server/lib/appEvents.ts: pushCapture: a slot or a function built by a call',
  'server/lib/contentCipher.ts: resolveContext: a parameter',
  'server/lib/deviceIdentity.ts: deviceInHand: a slot or a function built by a call',
  'server/lib/deviceIdentity.ts: forCitizen: a slot or a function built by a call',
  'server/lib/deviceIdentity.ts: forRequest: a slot or a function built by a call',
  'server/lib/deviceItem.ts: read: a local value',
  'server/lib/deviceItem.ts: readItemConvar[device]: a computed callee',
  'server/lib/framework/runtime.ts: lookup: a slot or a function built by a call',
  'server/lib/moderation.ts: recorder: a local value',
  'server/lib/numberRegistry.ts: handler: a local value',
  'server/lib/ownerConfig.ts: load: a parameter',
  'server/lib/payload.ts: REQUIRED[what]: a computed callee',
  'server/lib/payload.ts: parseCursor: a parameter',
  'server/lib/phoneNumbers.ts: random: a parameter',
  'server/lib/shell.ts: forget: a local value',
  'server/lib/shell.ts: which: a parameter',
  'server/lib/sweep/purge.ts: beforeErase: a slot or a function built by a call',
  'server/lib/versions.ts: readRows: a slot or a function built by a call',
  'server/services/Accounts.ts: onBlocked: a local value',
  'server/services/Accounts.ts: visibleOf: a local value',
  'server/services/Blabber.ts: channel.pushMany: an instance of no class the tree names',
  'server/services/Casino.ts: draw: a parameter',
  'server/services/Conversations.ts: numberOf: a local value',
  'server/services/Darkchat.ts: write: a parameter',
  'server/services/DarkchatMessages.ts: channel.pushMany: an instance of no class the tree names',
  'server/services/Devices.ts: work: a parameter',
  'server/services/Glimpse.ts: channel.pushMany: an instance of no class the tree names',
  'server/services/Invoices.ts: handler: a local value',
  'server/services/Mail.ts: run: a parameter',
  'server/services/Reports.ts: rule: a local value',
  'server/services/Spark.ts: channel.pushMany: an instance of no class the tree names',
  'server/services/Spark.ts: run: a parameter'
];

// ---------------------------------------------------------------------------------------------
// The documented list
// ---------------------------------------------------------------------------------------------

const SECURITY_MD = join(ROOT, 'docs', 'security.md');
const SECTION = '## Client-authoritative values';

/**
 * The section's `###` headings, each either an entry the client owns or one that moved, by the
 * suffix the section already uses. A heading with neither fails: a third kind of entry is a
 * decision about this parser, not something it should guess at.
 */
function documented(): { owned: string[]; moved: string[]; unclassified: string[] } {
  const text = readFileSync(SECURITY_MD, 'utf8');
  const start = text.indexOf(`\n${SECTION}\n`);
  if (start < 0) return { owned: [], moved: [], unclassified: [`no "${SECTION}" heading`] };
  const rest = text.slice(start + SECTION.length + 2);
  const end = rest.search(/^## /m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const out = { owned: [] as string[], moved: [] as string[], unclassified: [] as string[] };
  for (const [, heading] of body.matchAll(/^### (.+)$/gm)) {
    const owned = /^`([^`]+)` — legitimately client-owned$/.exec(heading as string);
    const moved = /^(.+) — moved$/.exec(heading as string);
    if (owned) out.owned.push(owned[1] as string);
    else if (moved) out.moved.push(moved[1] as string);
    else out.unclassified.push(heading as string);
  }
  return out;
}

/** Pinned as the doc has it. Adding an entry there is adding it here, in the same commit. */
const DOCUMENTED_CLIENT_OWNED = ['DeviceState.isTyping', 'PhoneOpenState.isDeviceOpen'];
const DOCUMENTED_MOVED = ['Battery charge', 'Signal bars'];

// ---------------------------------------------------------------------------------------------
// The derivation, over the tree
// ---------------------------------------------------------------------------------------------

const SERVER_FILES = sourceFiles(join(ROOT, 'server'));
const CLIENT_FILES = sourceFiles(join(ROOT, 'client'));

interface Derivation {
  entries: Entry[];
  trace: Trace;
  /** Device-state landings, by `landingKey`, each with the names of what reads it. */
  device: Map<string, string[]>;
}

function derive(side: 'server' | 'client', files: readonly string[]): Derivation {
  const entries = side === 'server' ? serverEntries(files) : clientEntries(files);
  const trace = traceAll(entries);
  const device = new Map<string, string[]>();
  for (const landing of trace.landings) {
    if (isDeviceState(side, landing)) device.set(landingKey(landing), nameOf(landing));
  }
  return { entries, trace, device };
}

const server = derive('server', SERVER_FILES);
const client = derive('client', CLIENT_FILES);
const landed = new Map([...server.device, ...client.device]);
const stateOfKey = (key: string): string => key.slice(0, key.indexOf(' <- '));
const unjudged = [...landed.keys()]
  .filter((key) => !(key in JUDGED) && !(stateOfKey(key) in JUDGED_STATE))
  .sort();
/** The values the code lets a client decide, by name. */
const DERIVED = [...new Set(unjudged.flatMap((key) => landed.get(key) ?? []))].sort();

const describeLandings = (keys: readonly string[]): string =>
  keys.map((key) => `  ${key}  =>  ${(landed.get(key) ?? []).join(', ')}`).join('\n');

// ---------------------------------------------------------------------------------------------
// A fixture the traversal must read correctly, both ways
// ---------------------------------------------------------------------------------------------

const FIXTURE = join(ROOT, 'server', '__clientAuthoritativeFixture__.ts');
const FIXTURE_TEXT = `
const held = new Map<number, boolean>();
const flags = new Set<number>();
let shared = '';
const store = (src: number, on: boolean): void => {
  if (!on) return;
  flags.add(src);
};
export const isHeld = (src: number): boolean => held.get(src) ?? false;
export const isFlagged = (src: number): boolean => flags.has(src);
export const __reset = (): void => held.clear();

onNet('mica:server:fixture:explicit', (...args: unknown[]) => {
  const [payload] = args as [{ open: boolean }];
  held.set(source, payload.open);
});
onNet('mica:server:fixture:branch', (...args: unknown[]) => {
  const guarded = guardNetEvent('fixture', 'branch', SCHEMA, args);
  if (!guarded) return;
  if (guarded.input[0]) held.delete(source);
});
onNet('mica:server:fixture:exit', (...args: unknown[]) => {
  store(source, args[0] === true);
});
onNet('mica:server:fixture:global', (...args: unknown[]) => {
  shared = String(args[0]);
});
onNet('mica:server:fixture:verdict', (...args: unknown[]) => {
  const guarded = guardNetEvent('fixture', 'verdict', SCHEMA, args);
  if (!guarded) return;
  held.set(source, true);
});
endpoint.registerEvent('mine', async (src, _cbId, data) => {
  held.set(src, (data as { on: boolean }).on);
});
endpoint.registerEvent('server', async (src, _cbId, _data, citizenid) => {
  held.set(src, citizenid === 'x');
});
const byCitizen = new Map<string, boolean>();
export const isOnFor = (citizenid: string): boolean => byCitizen.get(citizenid) ?? false;
endpoint.registerEvent('citizen', async (_src, _cbId, data, citizenid) => {
  byCitizen.set(citizenid, (data as { on: boolean }).on);
});
onNet('mica:server:fixture:closure', (...args: unknown[]) => {
  const put = (value: unknown): void => {
    flags.add(source); // unconditional: the payload decides nothing here, so it must not land
    shared = String(value);
  };
  put(args[0]);
});
class Box {
  private put(src: number, value: unknown): void {
    held.set(src, value === true);
  }
  run(src: number, value: unknown): void {
    this.put(src, value);
  }
}
const box = new Box();
onNet('mica:server:fixture:method', (...args: unknown[]) => {
  box.run(source, args[0]);
});
onNet('mica:server:fixture:opaque', (...args: unknown[]) => {
  const hook = args[1] as (value: unknown) => void;
  hook(args[0]);
});
`;

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe('the documented list (docs/security.md, "Client-authoritative values")', () => {
  it('reads every entry in the section as client-owned or moved, and nothing else', () => {
    const doc = documented();
    expect(doc.unclassified, 'headings the parser cannot classify').toEqual([]);
    expect(doc.owned.length + doc.moved.length, 'entries found').toBeGreaterThan(0);
  });

  it('is exactly the list pinned here', () => {
    const doc = documented();
    expect(doc.owned, 'legitimately client-owned').toEqual(DOCUMENTED_CLIENT_OWNED);
    expect(doc.moved, 'moved to the server').toEqual(DOCUMENTED_MOVED);
  });
});

describe('the derivation is not vacuous', () => {
  it('follows explicit, branched, early-exit, closure and method flows; not a verdict or a server value', () => {
    parseModule(FIXTURE, FIXTURE_TEXT);
    const fixture = derive('server', [FIXTURE]);
    expect([...fixture.device.keys()].sort()).toEqual(
      [
        'held <- server/__clientAuthoritativeFixture__.ts: mica:server:fixture:explicit',
        'held <- server/__clientAuthoritativeFixture__.ts: mica:server:fixture:branch',
        'flags <- server/__clientAuthoritativeFixture__.ts: mica:server:fixture:exit',
        'shared <- server/__clientAuthoritativeFixture__.ts: mica:server:fixture:global',
        'held <- server/__clientAuthoritativeFixture__.ts: registerEvent mine',
        'byCitizen <- server/__clientAuthoritativeFixture__.ts: registerEvent citizen',
        'shared <- server/__clientAuthoritativeFixture__.ts: mica:server:fixture:closure',
        'held <- server/__clientAuthoritativeFixture__.ts: mica:server:fixture:method'
      ]
        .map((key) => `server/__clientAuthoritativeFixture__.ts ${key}`)
        .sort()
    );
    expect(
      [...new Set([...fixture.device.values()].flat())].sort(),
      'named by exported readers'
    ).toEqual([
      '__clientAuthoritativeFixture__.isFlagged',
      '__clientAuthoritativeFixture__.isHeld',
      '__clientAuthoritativeFixture__.isOnFor',
      '__clientAuthoritativeFixture__.shared'
    ]);
    expect([...fixture.trace.unresolved], 'a callback it cannot open is reported').toEqual([
      'server/__clientAuthoritativeFixture__.ts: hook: a local value'
    ]);
  });

  it('found the whole client-reachable surface', () => {
    const count = (entries: Entry[], match: RegExp) =>
      entries.filter((entry) => match.test(entry.via)).length;
    // Pinned, so a scan that quietly stops finding handlers fails here first.
    expect(count(server.entries, /: mica:server:/), 'raw mica:server:* net events').toBe(9);
    expect(count(server.entries, /: registerEvent /), 'endpoint actions').toBe(155);
    expect(count(server.entries, /: registerGeneric /), 'generic CRUD actions').toBe(4);
    expect(server.entries.length, 'every server entry').toBe(172);
    // MICA-466's census counts the same 22 registration sites (`hostileNuiPayloads.test.ts`).
    expect(client.entries.length, 'NUI callbacks').toBe(22);
  });

  it('lost no trail: every unopened call is pinned with why, and none ran too deep', () => {
    expect([...server.trace.unresolved, ...client.trace.unresolved].sort()).toEqual(UNOPENED);
    expect([...server.trace.tooDeep, ...client.trace.tooDeep]).toEqual([]);
  });

  it('judged only what lands, so no excuse outlives its landing', () => {
    const stale = Object.keys(JUDGED).filter((key) => !landed.has(key));
    expect(stale, 'judged entries that no longer land').toEqual([]);
    const reached = new Set([...landed.keys()].map(stateOfKey));
    const staleState = Object.keys(JUDGED_STATE).filter((key) => !reached.has(key));
    expect(staleState, 'judged state nothing reaches any more').toEqual([]);
  });

  it('derives the documented entry, and exactly as many values as pinned', () => {
    const shown = `derived from:\n${describeLandings(unjudged)}`;
    expect(DERIVED.length, shown).toBeGreaterThan(0);
    expect(DERIVED, shown).toContain('DeviceState.isTyping');
    expect(DERIVED.length, shown).toBe(2);
  });
});

describe('the code against the list', () => {
  it('lets a client decide nothing the documented list does not name', () => {
    const undocumented = unjudged.filter((key) =>
      (landed.get(key) ?? []).some((name) => !DOCUMENTED_CLIENT_OWNED.includes(name))
    );
    expect(
      undocumented,
      'a client decides these and docs/security.md does not say why it cannot move:\n' +
        describeLandings(undocumented)
    ).toEqual([]);
  });
});
