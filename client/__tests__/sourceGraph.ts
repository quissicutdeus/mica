// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `client/` read as a call graph, by name, for `focusRelease.test.ts` (MICA-467).
 *
 * TypeScript 7 ships no compiler API to walk, so this reads the source the way
 * `hostileNuiPayloads.test.ts`'s census does: comments and string contents blanked first, so
 * prose that says "await" or "openDevice" is not code, then brackets matched.
 *
 * **Nodes** are function definitions — `const f = (...) =>`, `function f(`, a class's
 * `static` method, an object literal's member — and registrations: `onNet`, `on`,
 * `RegisterCommand` and `publish` (`lib/publicApi.ts`'s export registrar), each spanning its
 * whole argument list. **Edges** are references, called or not: a function handed to a
 * registration by name is reached as surely as one called inside it. A reference resolves
 * through the file's own definitions first, then its named imports, `@mica/shared/*` included.
 *
 * It over-approximates on purpose. A name that resolves is an edge whether or not that line
 * runs, so a path can only look wider than it is, never narrower — and every widening shows
 * up as a census mismatch someone has to read, rather than a path nobody covered.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const ROOT = join(__dirname, '..', '..');

interface Source {
  /** Repo-relative, forward slashes. */
  rel: string;
  text: string;
  /** `text` with comments and string contents blanked to spaces, every offset kept. */
  code: string;
}

/** Comments and string-literal contents to spaces; the quotes and every newline stay. */
export const blank = (text: string): string => {
  const out = text.split('');
  const fill = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      fill(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      fill(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      fill(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
};

/** The offset of the bracket closing the one at `open`, counting all three kinds together. */
const closeOf = (code: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
};

/** Where an expression starting at `from` ends: a `;` or `,` at its own depth, or its closer. */
const expressionEnd = (code: string, from: number): number => {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) return i - 1;
      depth--;
    } else if (depth === 0 && (ch === ';' || ch === ',')) return i - 1;
  }
  return code.length - 1;
};

/** The first `=>` after `from` at depth zero, within the same statement; -1 if none. */
const arrowAfter = (code: string, from: number): number => {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && (ch === '{' || ch === ';' || ch === ',')) return -1;
    else if (depth === 0 && ch === '=' && code[i + 1] === '>') return i;
  }
  return -1;
};

/** A body after `=>`: a braced block, or an expression. */
const arrowBodyEnd = (code: string, arrow: number): number => {
  let i = arrow + 2;
  while (/\s/.test(code[i] ?? '')) i++;
  return code[i] === '{' ? closeOf(code, i) : expressionEnd(code, i);
};

export type RegistrationKind = 'net' | 'nui' | 'event' | 'command' | 'export';

export interface GraphNode {
  /** `<file>:<name>`, `<file>:<Owner>.<name>`, or `<kind>:<registered name>` for a registration. */
  id: string;
  file: string;
  /** The span the node's code occupies: parameters and body, or a registration's arguments. */
  start: number;
  end: number;
  registration?: {
    kind: RegistrationKind;
    /** The registered name as written: a literal's value, else the expression's source. */
    name: string;
    literal: boolean;
  };
}

/** A point where an open path's code resumes later, or leaves a promise behind it. */
export interface AsyncSite {
  /** `<innermost node id>#<kind><ordinal within that node>`. */
  id: string;
  kind: 'await' | 'then' | 'catch' | 'void';
}

export interface FocusCall {
  file: string;
  offset: number;
  native: 'SetNuiFocus' | 'SetNuiFocusKeepInput';
  /** The first argument, when it is a literal. */
  takes: boolean | null;
}

interface Scope {
  functions: Set<string>;
  containers: Set<string>;
  imports: Map<string, { file: string; name: string }>;
}

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });

const relOf = (abs: string): string => relative(ROOT, abs).split('\\').join('/');

/** An import specifier to a repo-relative `.ts` file, or null for a package or a miss. */
const resolveImport = (fromRel: string, spec: string): string | null => {
  let base: string;
  if (spec.startsWith('@mica/shared/')) base = join(ROOT, 'shared', spec.slice(13));
  else if (spec.startsWith('.')) base = join(ROOT, dirname(fromRel), spec);
  else return null;
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return relOf(candidate);
  }
  return null;
};

const IDENT = '[A-Za-z_$][\\w$]*';
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new']);

export class SourceGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly sites: (AsyncSite & { file: string; offset: number })[] = [];
  readonly focusCalls: FocusCall[] = [];
  /** What the reader met and could not place, each with where. Asserted empty. */
  readonly unreadable: string[] = [];
  /** References to a node from outside every node: module scope. */
  readonly moduleRefs: { file: string; target: string }[] = [];

  private readonly sources = new Map<string, Source>();
  private readonly scopes = new Map<string, Scope>();
  private readonly edges = new Map<string, Set<string>>();
  /** Offsets of each definition's own name, which is not a reference to it. */
  private readonly nameOffsets = new Map<string, Set<number>>();

  constructor(entryDir = join(ROOT, 'client')) {
    const queue = sourceFiles(entryDir).map(relOf);
    while (queue.length > 0) {
      const rel = queue.shift() as string;
      if (this.sources.has(rel)) continue;
      const text = readFileSync(join(ROOT, rel), 'utf8');
      this.sources.set(rel, { rel, text, code: blank(text) });
      for (const target of this.readImports(rel)) queue.push(target);
    }
    for (const rel of this.sources.keys()) this.readDefinitions(rel);
    for (const rel of this.sources.keys()) {
      if (rel.startsWith('client/')) this.readRegistrations(rel);
    }
    for (const rel of this.sources.keys()) this.readReferences(rel);
    for (const rel of this.sources.keys()) {
      if (rel.startsWith('client/')) this.readSitesAndFocus(rel);
    }
  }

  private source(rel: string): Source {
    return this.sources.get(rel) as Source;
  }

  private readImports(rel: string): string[] {
    const { text, code } = this.source(rel);
    const scope: Scope = { functions: new Set(), containers: new Set(), imports: new Map() };
    this.scopes.set(rel, scope);
    const targets: string[] = [];
    // The specifier is a string, so read it from the text at the offsets the code matched.
    for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])/g)) {
      const quote = (m.index as number) + m[0].length;
      const spec = text.slice(quote, text.indexOf(m[2] as string, quote));
      const target = resolveImport(rel, spec);
      if (!target) continue;
      targets.push(target);
      for (const part of (m[1] as string).split(',')) {
        const words = part
          .replace(/^\s*type\s+/, '')
          .trim()
          .split(/\s+as\s+/);
        const name = words[0]?.trim();
        const local = (words[1] ?? words[0])?.trim();
        if (name && local) scope.imports.set(local, { file: target, name });
      }
    }
    return targets;
  }

  private addNode(node: GraphNode, nameOffset?: number): void {
    if (this.nodes.has(node.id)) {
      this.unreadable.push(`${node.id} is defined twice`);
      return;
    }
    this.nodes.set(node.id, node);
    if (nameOffset !== undefined) {
      const offsets = this.nameOffsets.get(node.file) ?? new Set<number>();
      offsets.add(nameOffset);
      this.nameOffsets.set(node.file, offsets);
    }
  }

  private readDefinitions(rel: string): void {
    const { code } = this.source(rel);
    const scope = this.scopes.get(rel) as Scope;

    // `class X {` — its static methods are `X.name`.
    const classes: { name: string; start: number; end: number }[] = [];
    for (const m of code.matchAll(new RegExp(`\\bclass\\s+(${IDENT})[^{]*\\{`, 'g'))) {
      const open = (m.index as number) + m[0].length - 1;
      classes.push({ name: m[1] as string, start: open, end: closeOf(code, open) });
      scope.containers.add(m[1] as string);
    }
    const methodRe = new RegExp(
      `\\b(?:(?:public|private|protected)\\s+)?static\\s+(?:async\\s+)?(${IDENT})\\s*(?:<[^>]*>)?\\s*\\(`,
      'g'
    );
    for (const m of code.matchAll(methodRe)) {
      const paren = (m.index as number) + m[0].length - 1;
      const owner = classes.find((c) => c.start < paren && paren < c.end);
      if (!owner) continue;
      const brace = code.indexOf('{', closeOf(code, paren));
      const name = m[1] as string;
      this.addNode(
        { id: `${rel}:${owner.name}.${name}`, file: rel, start: paren, end: closeOf(code, brace) },
        paren - (m[0].length - m[0].indexOf(name))
      );
    }

    // `const f = (...) =>` and `const f = <T>(...) =>`, at any depth.
    const arrowRe = new RegExp(
      `\\b(?:const|let)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*(?:async\\s+)?(?:<[^>]*>\\s*)?\\(`,
      'g'
    );
    for (const m of code.matchAll(arrowRe)) {
      const paren = (m.index as number) + m[0].length - 1;
      const arrow = arrowAfter(code, closeOf(code, paren) + 1);
      if (arrow === -1) continue;
      const name = m[1] as string;
      scope.functions.add(name);
      this.addNode(
        { id: `${rel}:${name}`, file: rel, start: paren, end: arrowBodyEnd(code, arrow) },
        (m.index as number) + m[0].indexOf(name)
      );
    }

    // `function f(`.
    for (const m of code.matchAll(
      new RegExp(`\\bfunction\\s+(${IDENT})\\s*(?:<[^>]*>)?\\s*\\(`, 'g')
    )) {
      const paren = (m.index as number) + m[0].length - 1;
      const brace = code.indexOf('{', closeOf(code, paren));
      const name = m[1] as string;
      scope.functions.add(name);
      this.addNode(
        { id: `${rel}:${name}`, file: rel, start: paren, end: closeOf(code, brace) },
        (m.index as number) + m[0].indexOf(name)
      );
    }

    // `const X = {` — its function-valued members are `X.name`.
    for (const m of code.matchAll(
      new RegExp(`\\b(?:const|let)\\s+(${IDENT})\\s*(?::[^=;{]+)?=\\s*\\{`, 'g')
    )) {
      const open = (m.index as number) + m[0].length - 1;
      const end = closeOf(code, open);
      const owner = m[1] as string;
      const body = code.slice(open, end);
      for (const member of body.matchAll(
        new RegExp(`(^|[{,]\\s*|\\n\\s*)(?:async\\s+)?(${IDENT})\\s*(:\\s*(?:async\\s*)?)?\\(`, 'g')
      )) {
        const name = member[2] as string;
        if (KEYWORDS.has(name)) continue;
        const paren = open + (member.index as number) + member[0].length - 1;
        // A direct member only: one bracket deep from the object's own brace.
        if (this.depthBetween(code, open, paren) !== 1) continue;
        let bodyEnd: number;
        if (member[3]) {
          const arrow = arrowAfter(code, closeOf(code, paren) + 1);
          if (arrow === -1) continue;
          bodyEnd = arrowBodyEnd(code, arrow);
        } else {
          const brace = code.indexOf('{', closeOf(code, paren));
          bodyEnd = closeOf(code, brace);
        }
        scope.containers.add(owner);
        this.addNode(
          { id: `${rel}:${owner}.${name}`, file: rel, start: paren, end: bodyEnd },
          open + (member.index as number) + member[0].indexOf(name, (member[1] as string).length)
        );
      }
    }
  }

  private depthBetween(code: string, from: number, to: number): number {
    let depth = 0;
    for (let i = from; i < to; i++) {
      const ch = code[i];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
    }
    return depth;
  }

  private readRegistrations(rel: string): void {
    const { text, code } = this.source(rel);
    for (const m of code.matchAll(/(?<![\w$.])(onNet|on|RegisterCommand|publish)\s*\(/g)) {
      const paren = (m.index as number) + m[0].length - 1;
      const firstEnd = expressionEnd(code, paren + 1);
      const raw = text.slice(paren + 1, firstEnd + 1).trim();
      const quoted = /^(['"`])([^'"`$]*)\1$/.exec(raw);
      let name = quoted ? (quoted[2] as string) : raw;
      let kind: RegistrationKind;
      const fn = m[1] as string;
      if (fn === 'onNet') kind = 'net';
      else if (fn === 'RegisterCommand') kind = 'command';
      else if (fn === 'publish') kind = 'export';
      else if (/^['"`]__cfx_nui:/.test(raw)) {
        kind = 'nui';
        name = quoted ? name.slice('__cfx_nui:'.length) : raw;
      } else kind = 'event';
      const id = `${kind}:${name}`;
      // The same name registered twice is two nodes; the census reads that as two paths.
      const unique = this.nodes.has(id) ? `${id}@${rel}:${paren}` : id;
      this.nodes.set(unique, {
        id: unique,
        file: rel,
        start: paren,
        end: closeOf(code, paren),
        registration: { kind, name, literal: quoted !== null }
      });
    }
  }

  /** The node with the smallest span in `file` containing `offset`, or null at module scope. */
  innermost(file: string, offset: number): GraphNode | null {
    let best: GraphNode | null = null;
    for (const node of this.nodes.values()) {
      if (node.file !== file || offset < node.start || offset > node.end) continue;
      if (!best || node.end - node.start < best.end - best.start) best = node;
    }
    return best;
  }

  private resolve(file: string, head: string, member: string | undefined): string | null {
    const scope = this.scopes.get(file) as Scope;
    const imported = scope.imports.get(head);
    if (member) {
      const owner = scope.containers.has(head)
        ? `${file}:${head}.${member}`
        : imported
          ? `${imported.file}:${imported.name}.${member}`
          : null;
      if (owner && this.nodes.has(owner)) return owner;
    }
    if (scope.functions.has(head) && this.nodes.has(`${file}:${head}`)) return `${file}:${head}`;
    if (imported && this.nodes.has(`${imported.file}:${imported.name}`)) {
      return `${imported.file}:${imported.name}`;
    }
    return null;
  }

  private readReferences(rel: string): void {
    const { code } = this.source(rel);
    const own = this.nameOffsets.get(rel) ?? new Set<number>();
    // An import or re-export names a function without reaching it.
    const declarations: [number, number][] = [
      ...code.matchAll(/\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}[^;]*;/g)
    ].map((m) => [m.index as number, (m.index as number) + m[0].length]);
    const refRe = new RegExp(`(?<![\\w$.])(${IDENT})(?:\\s*\\??\\.\\s*(${IDENT}))?`, 'g');
    for (const m of code.matchAll(refRe)) {
      const at = m.index as number;
      if (own.has(at) || declarations.some(([a, b]) => at >= a && at < b)) continue;
      const target = this.resolve(rel, m[1] as string, m[2]);
      if (!target) continue;
      const from = this.innermost(rel, at);
      if (!from) {
        this.moduleRefs.push({ file: rel, target });
        continue;
      }
      if (from.id === target) continue;
      const set = this.edges.get(from.id) ?? new Set<string>();
      set.add(target);
      this.edges.set(from.id, set);
    }
    // A node's code reaches whatever is nested inside its span, too.
    for (const inner of this.nodes.values()) {
      if (inner.file !== rel) continue;
      const outer = this.innermost(rel, inner.start - 1);
      if (!outer || outer.id === inner.id) continue;
      const set = this.edges.get(outer.id) ?? new Set<string>();
      set.add(inner.id);
      this.edges.set(outer.id, set);
    }
  }

  private readSitesAndFocus(rel: string): void {
    const { code } = this.source(rel);
    const counters = new Map<string, number>();
    const patterns: [AsyncSite['kind'], RegExp][] = [
      ['await', /\bawait\b/g],
      ['then', /\.then\s*\(/g],
      ['catch', /\.catch\s*\(/g],
      ['void', new RegExp(`\\bvoid\\s+${IDENT}(?:\\.${IDENT})*\\s*\\(`, 'g')]
    ];
    const found: { kind: AsyncSite['kind']; offset: number }[] = [];
    for (const [kind, re] of patterns) {
      for (const m of code.matchAll(re)) found.push({ kind, offset: m.index as number });
    }
    found.sort((a, b) => a.offset - b.offset);
    for (const { kind, offset } of found) {
      const node = this.innermost(rel, offset);
      const owner = node?.id ?? `${rel}:<module>`;
      const key = `${owner}#${kind}`;
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      this.sites.push({ id: `${key}${n}`, kind, file: rel, offset });
    }

    for (const m of code.matchAll(/\b(SetNuiFocus|SetNuiFocusKeepInput)\s*\(\s*([^,)]*)/g)) {
      const arg = (m[2] as string).trim();
      const takes = arg === 'true' ? true : arg === 'false' ? false : null;
      if (takes === null) this.unreadable.push(`${rel}: ${m[1]}(${arg}, ...) is not a literal`);
      this.focusCalls.push({
        file: rel,
        offset: m.index as number,
        native: m[1] as FocusCall['native'],
        takes
      });
    }
  }

  /**
   * Every node reachable from `id`, itself included. With `intoRegistrations` false, a
   * registration nested in the code is not entered: calling the function that registers a
   * handler runs none of that handler.
   */
  reach(id: string, { intoRegistrations = true } = {}): Set<string> {
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      for (const next of this.edges.get(queue.shift() as string) ?? []) {
        if (seen.has(next)) continue;
        if (!intoRegistrations && this.nodes.get(next)?.registration) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  }

  registrations(): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.registration);
  }

  /** The node holding each focus-taking call, or `<file>:<module>` for one at module scope. */
  focusTakers(): Set<string> {
    const takers = new Set<string>();
    for (const call of this.focusCalls) {
      if (call.takes !== true) continue;
      takers.add(this.innermost(call.file, call.offset)?.id ?? `${call.file}:<module>`);
    }
    return takers;
  }

  /** The async sites inside the nodes `id` reaches, attributed to the innermost node. */
  sitesReachedFrom(id: string): string[] {
    const reached = this.reach(id);
    return this.sites
      .filter((s) => reached.has(s.id.slice(0, s.id.lastIndexOf('#'))))
      .map((s) => s.id)
      .sort();
  }
}
