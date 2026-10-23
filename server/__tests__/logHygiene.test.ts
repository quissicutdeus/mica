// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { lexScript, type Read } from './sourceLexer';

/**
 * No server log line names a player or a phone, or prints a raw database error (MICA-433).
 *
 * A server console is pasted into Discord, shipped to log hosts and read by staff. Two things
 * were reaching it from dozens of call sites:
 *
 * - **A raw error object.** An oxmysql error's message embeds the statement and every bound
 *   value, so `console.error('…', error)` printed whatever the query was about — citizenids,
 *   numbers, message bodies. `reasonOf(error)` is the driver's last line and nothing else;
 *   `traceOf(error)` adds the stack's frames and nothing of the message.
 * - **An identity**: a citizenid (on ESX the player's Rockstar licence), a phone number, a
 *   device id. `who(id)` (`server/lib/who.ts`) is a short stable token that lets staff tie lines
 *   together without the id.
 *
 * Read from source by the lexer `genericCrudCallers` proved (`sourceLexer.ts`): strings and
 * template text are blanked, so only code is judged. What is judged:
 *
 * - every `console.*` call's arguments, and
 * - every call to a **log wrapper** — a named function that hands one of its own parameters to
 *   `console.*` (`reportOnce(key, message)`) — at the arguments it hands on. The wrappers are
 *   found from source and must all be listed in `WRAPPERS` below, so a new one fails here until
 *   somebody has looked at it.
 *
 * Inside an argument, `reasonOf(…)`, `traceOf(…)` and `who(…)` may name anything; outside them, a
 * word naming an error, or any identifier containing an identity's name (`citizenid`, `phone`,
 * `number`, `deviceId`…), or a bracketed read of one (`row['citizenid']`), fails the line.
 *
 * Wrappers are found as `const`/`let` arrows, function declarations and class methods (plain or
 * arrow-valued members, any modifiers), and followed through each other to a fixed point. A call
 * resolves to one by bare name, by a named import (through `export { … } from` and `export *
 * from` re-exports), as `ns.name(` of an `import * as ns`, or as `this.name(` / `Class.name(`;
 * `obj.name(` resolves only to a method defined in the same file. A bare `console.<level>` handed
 * on as a value (`.catch(console.error)`, `console.warn.bind(…)`) fails, since nothing after it
 * is judged.
 *
 * **Known limits.** The scan reads names, not values, so it cannot see:
 *
 * - a local alias: `const id = player.citizenid; console.log(id)`;
 * - a wrapper reached as a value rather than called by name: `list.forEach(warn)`, a function in
 *   an object literal (`log.warn(…)` of `const log = { warn: … }`), a default export;
 * - a method called on an instance of a class from another file (`bridge.warn(…)` where `bridge`
 *   is not the class's own name).
 *
 * Any of these is one review away from being a leak this test does not catch.
 *
 * **Fails closed.** A file the lexer cannot close, or a judged call whose parentheses do not
 * balance, is a failure naming that file — never a file that passes for being unreadable.
 */

const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');

/** A word that, as code in a log argument, is an error object or something read off one. */
const ERROR_WORDS = /^(e|err|error|cause|failure|exception)$/;

/**
 * An identifier that holds who or what a player is: any name containing one of these, in any
 * case — `citizenid`, `targetCitizenId`, `phoneNumber`, `number`, `deviceId`, `device_id` — and
 * the bare words this codebase also gives them.
 */
const IDENTITY_PART = /citizen_?id|phone|number|device_?id/i;
const IDENTITY_WORDS =
  /^(cid|owner|holder|payer|payee|recipient|from|to|target|identifier|license)$/;

/** Names that contain an identity's word and hold none: a constant, a builtin. */
const NOT_A_VALUE = (word: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(word) || word === 'Number';

/**
 * Calls whose argument a log line may name anything inside: they answer a token or one safe
 * line. `notificationFailureReason` and `mediaHost`'s `failureOf` are `reasonOf` with a
 * fallback; `DiscordWebhook`'s `safeReasonOf` is a fetch reason with every URL reduced to its
 * origin; `describeIdentifierRejection` says what was wrong with an identifier, never the
 * identifier (`shared/framework.ts`).
 */
const ALLOWED_CALLS = [
  'who',
  'reasonOf',
  'traceOf',
  'notificationFailureReason',
  'failureOf',
  'safeReasonOf',
  'describeIdentifierRejection'
];

/**
 * The one way past the identity check, and it has to say why: a comment on the line above the
 * call, `// log-identity-ok: <reason>`, for a line naming something that is not a player — a
 * job line's public number, the resource that owns a line. Never for an error: there is no
 * reason to print one raw.
 */
const IDENTITY_WAIVER = /\/\/\s*log-identity-ok:\s*\S/;

/**
 * Every log wrapper in `server/`, as `file:name`: a function whose job is to log what it is
 * given, because one of its parameters *is* a `console.*` argument (`relay`). Found from source
 * (`findWrappers`); one missing from here fails the completeness test, and so does an entry that
 * no longer is one.
 *
 * Coverage does not rest on this list. Every function that puts a parameter into a log line —
 * a wrapper or a handler that interpolates `${what}` — has its calls judged at that parameter.
 * The list is the reviewed set of functions whose whole purpose is the line.
 */
const WRAPPERS = [
  'server/lib/FrameworkBridge.ts:FrameworkBridge.registerUsableItem',
  'server/lib/ServiceEndpoint.ts:ServiceEndpoint.dispatch',
  'server/lib/contentCipher.ts:sayOnce',
  'server/lib/contentRetention.ts:sayOnce',
  'server/lib/deviceItem.ts:reportOnce',
  'server/lib/exports.ts:guarded',
  'server/lib/exports.ts:guardedAsync',
  'server/lib/framework/esx.ts:refuseEsx',
  'server/lib/framework/itemMetadata.ts:reportOnce',
  'server/lib/framework/runtime.ts:offlineLookup',
  'server/lib/framework/runtime.ts:reportRemovalOnce',
  'server/lib/framework/standalone.ts:standaloneRegisterUsableItem',
  'server/lib/locales.ts:loadLocales',
  'server/lib/locales.ts:readNamespace',
  'server/lib/locales.ts:reloadLocales',
  'server/lib/locales.ts:warn',
  'server/lib/mediaHost.ts:warnOnce',
  'server/lib/ownerConfig.ts:listWallpapers',
  'server/lib/ownerConfig.ts:sayOnce',
  'server/lib/schemaBootstrap.ts:refuse',
  'server/lib/sweep/owner.ts:announceSkip',
  'server/services/Battery.ts:respond',
  'server/services/ContentKeys.ts:say',
  'server/services/OutboundHttp.ts:complain',
  'server/services/OutboundHttp.ts:say',
  'server/services/Phone.ts:respondCall',
  'server/services/PhoneNumbers.ts:assign',
  'server/services/PhoneNumbers.ts:ensureNumber',
  'server/services/PhoneNumbers.ts:numberForPhone',
  'server/services/PhoneNumbers.ts:reportOnce',
  'server/services/PlacesLive.ts:warnOnce',
  'server/services/Seed.ts:respond',
  'server/services/Source.ts:warnLocaleOnce',
  'server/services/Spark.ts:pushQuietly'
];

const CONSOLE = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/g;

/** The index of the bracket closing the one at `open`, counted in code, or -1. */
const closing = (code: string, open: number): number => {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const want = pairs[code[open]!];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === code[open]) depth++;
    else if (code[i] === want && --depth === 0) return i;
  }
  return -1;
};

/** `[start, end)` spans of the top-level arguments between `open` and `close`. */
const argumentSpans = (code: string, open: number, close: number): [number, number][] => {
  const out: [number, number][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (code.slice(start, close).trim() !== '') out.push([start, close]);
  return out;
};

/** A slice with each allowed call blanked, parentheses and all, at the same length. */
const withoutAllowed = (slice: string): string => {
  let out = slice;
  for (const name of ALLOWED_CALLS) {
    const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(out)) !== null) {
      const end = closing(out, match.index + match[0].length - 1);
      if (end < 0) return out; // unbalanced: left in, so its words are judged
      out = out.slice(0, match.index) + ' '.repeat(end + 1 - match.index) + out.slice(end + 1);
      pattern.lastIndex = match.index;
    }
  }
  return out;
};

/**
 * The words an argument uses as code, each with whether it is read off something (`x.word`), is
 * an object key (`{ word: … }`, which names a field rather than holding a value), or is read
 * through (`word.x`, where the field read is what is logged).
 */
const wordsOf = (
  code: string
): { word: string; property: boolean; key: boolean; object: boolean }[] =>
  [...code.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => {
    const before = code.slice(0, m.index).trimEnd();
    const after = code.slice(m.index + m[0].length).trimStart();
    return {
      word: m[0],
      property: before.endsWith('.'),
      key: /^:(?!:)/.test(after),
      object: /^\??\.(?!\.)/.test(after)
    };
  });

const isIdentity = (word: string): boolean =>
  !NOT_A_VALUE(word) && (IDENTITY_PART.test(word) || IDENTITY_WORDS.test(word));

/** What is wrong with one argument, given its code and text views at the same span. */
const judge = (code: string, text: string, waived: boolean): string[] => {
  const problems: string[] = [];
  const blanked = withoutAllowed(code);
  for (const { word, property, key, object } of wordsOf(blanked)) {
    if (ERROR_WORDS.test(word) && !property && !key) {
      // `error.message` too: an oxmysql error's message is the statement and its values.
      problems.push(`logs '${word}' raw — use reasonOf()`);
    } else if (isIdentity(word) && !key && !object && !waived) {
      problems.push(`logs '${word}' — use who()`);
    }
  }
  // A bracketed read: the key is a string, so only the text view has its name.
  for (const m of text.matchAll(/\[\s*(['"`])([\w$]+)\1\s*\]/g)) {
    const inCode = blanked[m.index] === '[';
    if (inCode && isIdentity(m[2]!) && !waived) problems.push(`logs '${m[2]}' — use who()`);
  }
  return problems;
};

/** A named function as the scan reads it: a top-level function, or a method of a class. */
interface Fn {
  file: string;
  name: string;
  /** The class it is a method of, or null for a function. */
  owner: string | null;
  params: string[];
  /** The parameters declared `: string`. */
  strings: Set<string>;
  /** Its body's span in the file's code. */
  body: [number, number];
  /** Where its name is defined, so that is not read as a call. */
  head: number;
  exported: boolean;
}

/** A function that puts one of its arguments into a log line, directly or through another. */
interface Wrapper {
  file: string;
  name: string;
  owner: string | null;
  /** Which of its arguments reach a `console.*` call. */
  forwarded: number[];
  exported: boolean;
  /**
   * A log wrapper proper: a `string` parameter it is given *is* a log argument, alone or with
   * only literal text around it (`console.warn(message)`, `` `[x] ${message}` ``), or is handed
   * on whole to another wrapper proper.
   */
  relay: boolean;
}

/** A named function's parameters, by name, from its parameter list's code. */
const paramNames = (list: string): string[] =>
  list
    .split(',')
    .map(
      (p) =>
        /^\s*(?:(?:public|private|protected|readonly)\s+)*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(
          p
        )?.[1] ?? ''
    )
    .filter(Boolean);

/** The parameters declared `: string` — a line or a message, as a log wrapper takes one. */
const stringParams = (list: string): Set<string> =>
  new Set(
    list
      .split(',')
      .map((p) => /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*string\b/.exec(p)?.[1] ?? '')
      .filter(Boolean)
  );

/** The end of an arrow's expression body that starts at `at`: the statement's end. */
const expressionEnd = (code: string, at: number): number => {
  let depth = 0;
  for (let end = at; end < code.length; end++) {
    const ch = code[end]!;
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return end;
      depth--;
    } else if ((ch === ';' || ch === '\n') && depth === 0) return end;
  }
  return code.length;
};

const KEYWORDS = new Set(
  'if for while switch catch return function constructor super new typeof await do else'.split(' ')
);

/**
 * Every named function in a file: `const name = (…) => …`, `function name(…) {…}`, and a class's
 * methods — `name(…) {…}` and `name = (…) => …` among its members, any modifiers before them.
 */
export const functionsOf = (file: string, read: Read): Fn[] => {
  const { code } = read;
  const found: Fn[] = [];
  const add = (
    name: string,
    owner: string | null,
    open: number,
    exported: boolean,
    head: number,
    arrow: boolean
  ) => {
    const close = closing(code, open);
    if (close < 0) return;
    const list = code.slice(open + 1, close);
    let at = close + 1;
    if (arrow) {
      const to = code.indexOf('=>', at);
      if (to < 0 || /[;{]/.test(code.slice(at, to).replace(/\{[^}]*\}/g, ''))) return;
      at = to + 2;
    } else {
      // Past a return type to the body's brace; a statement end first means no body.
      let i = at;
      let depth = 0;
      for (; i < code.length; i++) {
        const ch = code[i]!;
        if (ch === '{' && depth === 0) break;
        if ('(<['.includes(ch)) depth++;
        else if (')>]'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) return;
      }
      at = i;
    }
    while (/\s/.test(code[at] ?? '')) at++;
    const end = code[at] === '{' ? closing(code, at) : expressionEnd(code, at);
    if (end < 0) return;
    found.push({
      file,
      name,
      owner,
      params: paramNames(list),
      strings: stringParams(list),
      body: [at, end],
      head,
      exported
    });
  };

  for (const m of code.matchAll(
    /\b(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:<[^>]*>\s*)?\(/g
  )) {
    add(m[2]!, null, m.index + m[0].length - 1, Boolean(m[1]), m.index, true);
  }
  for (const m of code.matchAll(
    /\b(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>\s*)?\(/g
  )) {
    add(m[2]!, null, m.index + m[0].length - 1, Boolean(m[1]), m.index, false);
  }
  for (const c of code.matchAll(
    /\b(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)[^{]*\{/g
  )) {
    const open = c.index + c[0].length - 1;
    const close = closing(code, open);
    if (close < 0) continue;
    // Members sit at the class body's own depth; anything nested is inside a member.
    let depth = 0;
    const member =
      /^(?:(?:public|private|protected|static|async|readonly|override)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(=\s*(?:async\s+)?)?\(/;
    for (let i = open + 1; i < close; i++) {
      const ch = code[i]!;
      if ('({['.includes(ch)) {
        depth++;
        continue;
      }
      if (')}]'.includes(ch)) {
        depth--;
        continue;
      }
      if (depth !== 0 || !/[A-Za-z_$]/.test(ch) || /[\w$.]/.test(code[i - 1] ?? '')) continue;
      const m = member.exec(code.slice(i, close));
      if (!m || KEYWORDS.has(m[1]!)) continue;
      const paren = i + m[0].length - 1;
      add(m[1]!, c[2]!, paren, Boolean(c[1]), i, Boolean(m[2]));
      const fn = found[found.length - 1];
      if (fn?.head === i) i = fn.body[1];
    }
  }
  return found;
};

/** One module's code, its functions, and how it names other modules' functions. */
interface Module {
  path: string;
  file: string;
  /** The source as written: the only view with comments in it, where a waiver is read. */
  src: string;
  read: Read;
  fns: Fn[];
  /** `name` imported by name, to the module path it came from and the name it has there. */
  named: Map<string, { from: string; as: string }>;
  /** `ns` of an `import * as ns`, to the module path. */
  namespaces: Map<string, string>;
  /** Names re-exported (`export { a as b } from`), and modules re-exported whole. */
  reexports: { names: Map<string, { from: string; as: string }>; all: string[] };
}

const moduleOf = (path: string, file: string, src: string): Module | null => {
  const read = lexScript(src);
  if (!read.ok) return null;
  const target = (spec: string) => resolve(dirname(path), spec).replace(/\.ts$/, '');
  const named = new Map<string, { from: string; as: string }>();
  const namespaces = new Map<string, string>();
  const reexports = { names: new Map<string, { from: string; as: string }>(), all: [] as string[] };
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    for (const part of m[1]!.split(',')) {
      const [as, local] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      if (as) named.set(local ?? as, { from: target(m[2]!), as });
    }
  }
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*'(\.[^']*)'/g)) {
    namespaces.set(m[1]!, target(m[2]!));
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    for (const part of m[1]!.split(',')) {
      const [as, out] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      if (as) reexports.names.set(out ?? as, { from: target(m[2]!), as });
    }
  }
  for (const m of src.matchAll(/export\s*\*\s*from\s*'(\.[^']*)'/g))
    reexports.all.push(target(m[1]!));
  return {
    path: path.replace(/\.ts$/, ''),
    file,
    src,
    read,
    fns: functionsOf(file, read),
    named,
    namespaces,
    reexports
  };
};

/**
 * How a module's calls resolve to functions: a local function, a named import (through any
 * re-exports), `ns.name(` of an `import * as ns`, or a method — `this.name(`, `Class.name(` of a
 * class in reach, or `obj.name(` of a method defined in the same file.
 */
const makeResolver = (modules: Module[]) => {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const all = modules.flatMap((m) => m.fns);
  /** What `name` exported from `path` is, following re-exports; cycles stop. */
  const exported = (path: string, name: string, seen = new Set<string>()): Fn[] => {
    if (seen.has(`${path}:${name}`)) return [];
    seen.add(`${path}:${name}`);
    const m = byPath.get(path);
    if (!m) return [];
    const own = m.fns.filter(
      (f) => f.exported && (f.owner === null ? f.name === name : f.owner === name)
    );
    if (own.length > 0) return own;
    const re = m.reexports.names.get(name);
    if (re) return exported(re.from, re.as, seen);
    return m.reexports.all.flatMap((from) => exported(from, name, seen));
  };

  /** Every call in a module to a function that may forward, with what it calls. */
  const callsIn = (m: Module): { open: number; callee: Fn }[] => {
    const { code } = m.read;
    const heads = new Set(m.fns.map((f) => f.head));
    const out: { open: number; callee: Fn }[] = [];
    for (const call of code.matchAll(/([A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[2]!;
      const open = call.index + call[0].length - 1;
      const before = code.slice(Math.max(0, call.index - 12), call.index);
      if (/(?:const|let|function)\s+$/.test(before)) continue;
      if (call[1] === undefined && /\.\s*$/.test(code.slice(0, call.index))) continue;
      const qualifier = call[1]?.replace(/\s*\.\s*$/, '');
      let callees: Fn[] = [];
      if (qualifier === undefined) {
        if (heads.has(call.index)) continue; // a method's own definition
        const local = m.fns.filter((f) => f.owner === null && f.name === name);
        const imported = m.named.get(name);
        callees = local.length > 0 ? local : imported ? exported(imported.from, imported.as) : [];
      } else if (m.namespaces.has(qualifier)) {
        callees = exported(m.namespaces.get(qualifier)!, name);
      } else {
        // A method: `this.name(`, `Class.name(`, `obj.name(` — any class in reach with one.
        const classes = new Set<string>(m.fns.filter((f) => f.owner).map((f) => f.owner!));
        for (const [local, { from, as }] of m.named) {
          if (exported(from, as).some((f) => f.owner)) classes.add(local);
        }
        callees = all.filter(
          (f) =>
            f.owner !== null &&
            f.name === name &&
            (qualifier === 'this' || classes.has(f.owner) || classes.has(qualifier))
        );
        if (qualifier !== 'this' && !classes.has(qualifier)) {
          callees = callees.filter((f) => f.file === m.file);
        }
      }
      for (const callee of callees) out.push({ open, callee });
    }
    return out;
  };

  return { all, callsIn };
};

/**
 * Every wrapper in a set of modules, followed to a fixed point: a function forwards an argument
 * when that argument reaches a `console.*` call, or reaches a forwarded argument of another
 * wrapper it calls — however many wrappers deep.
 */
export const findWrappers = (modules: Module[]): Wrapper[] => {
  const { all, callsIn } = makeResolver(modules);
  const forwarded = new Map<Fn, Set<number>>();
  const relay = new Set<Fn>();
  for (const fn of all) forwarded.set(fn, new Set());

  const calls = new Map(modules.map((m) => [m, callsIn(m)]));
  const inside = (fn: Fn, at: number) => at > fn.body[0] && at < fn.body[1];

  for (let changed = true; changed;) {
    changed = false;
    for (const m of modules) {
      const { code } = m.read;
      for (const fn of m.fns) {
        const mine = forwarded.get(fn)!;
        const take = (a: number, b: number, whole: boolean) => {
          const words = wordsOf(withoutAllowed(code.slice(a, b)));
          // A parameter read through (`row.title`) is judged where it is read, not forwarded.
          for (const { word, property, key, object } of words) {
            const index = fn.params.indexOf(word);
            if (index >= 0 && !property && !key && !object && !mine.has(index)) {
              mine.add(index);
              changed = true;
            }
          }
          if (whole && words.length === 1 && fn.strings.has(words[0]!.word) && !relay.has(fn)) {
            relay.add(fn);
            changed = true;
          }
        };
        for (const call of code.slice(...fn.body).matchAll(CONSOLE)) {
          const open = fn.body[0] + call.index + call[0].length - 1;
          const close = closing(code, open);
          if (close < 0) continue;
          for (const [a, b] of argumentSpans(code, open, close)) take(a, b, true);
        }
        for (const { open, callee } of calls.get(m)!) {
          if (callee === fn || !inside(fn, open)) continue;
          const hands = forwarded.get(callee)!;
          if (hands.size === 0) continue;
          const close = closing(code, open);
          if (close < 0) continue;
          argumentSpans(code, open, close).forEach(([a, b], index) => {
            if (hands.has(index)) take(a, b, relay.has(callee));
          });
        }
      }
    }
  }

  return all
    .filter((fn) => forwarded.get(fn)!.size > 0)
    .map((fn) => ({
      file: fn.file,
      name: fn.owner ? `${fn.owner}.${fn.name}` : fn.name,
      owner: fn.owner,
      forwarded: [...forwarded.get(fn)!].sort(),
      exported: fn.exported,
      relay: relay.has(fn)
    }));
};

export interface Finding {
  file: string;
  line: number;
  problem: string;
}

/** A `console.<level>` named without calling it: handed on, its arguments are never judged. */
const CONSOLE_REFERENCE = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\b(?!\s*\()/g;

/**
 * Every finding in a set of modules: `console.*` calls and bare references, and every call to a
 * function that forwards an argument into a log line, judged at the arguments it forwards.
 */
export const scanModules = (modules: Module[]): Finding[] => {
  const wrappers = findWrappers(modules);
  const byFn = new Map<string, Wrapper>(wrappers.map((w) => [`${w.file}:${w.name}`, w]));
  const { callsIn } = makeResolver(modules);
  const findings: Finding[] = [];

  for (const m of modules) {
    const { code, text } = m.read;
    const lines = m.src.split('\n');
    const lineAt = (index: number) => code.slice(0, index).split('\n').length;
    const waivedAt = (line: number) => IDENTITY_WAIVER.test(lines[line - 2] ?? '');

    for (const ref of code.matchAll(CONSOLE_REFERENCE)) {
      const line = lineAt(ref.index);
      if (!waivedAt(line)) {
        findings.push({
          file: m.file,
          line,
          problem: `hands console.${ref[1]} on as a value, so what it prints is never judged`
        });
      }
    }

    const sites: { open: number; only: number[] | null }[] = [];
    for (const call of code.matchAll(CONSOLE)) {
      sites.push({ open: call.index + call[0].length - 1, only: null });
    }
    // The same resolution `findWrappers` used, now for every call in this module.
    for (const { open, callee } of callsIn(m)) {
      const w = byFn.get(
        `${callee.file}:${callee.owner ? `${callee.owner}.${callee.name}` : callee.name}`
      );
      if (w) sites.push({ open, only: w.forwarded });
    }

    for (const { open, only } of sites) {
      const line = lineAt(open);
      const close = closing(code, open);
      if (close < 0) {
        findings.push({ file: m.file, line, problem: 'a log call that never closes' });
        continue;
      }
      const waived = waivedAt(line);
      argumentSpans(code, open, close).forEach(([a, b], index) => {
        if (only && !only.includes(index)) return;
        for (const problem of judge(code.slice(a, b), text.slice(a, b), waived)) {
          findings.push({ file: m.file, line, problem });
        }
      });
    }
  }
  return findings;
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path);
    return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });

/** Modules from source, failing closed: one the lexer cannot read is a finding of its own. */
const modulesOf = (
  files: { path: string; file: string; src: string }[]
): { modules: Module[]; unreadable: Finding[] } => {
  const modules: Module[] = [];
  const unreadable: Finding[] = [];
  for (const { path, file, src } of files) {
    const m = moduleOf(path, file, src);
    if (m) modules.push(m);
    else unreadable.push({ file, line: 0, problem: 'could not be read; nothing in it is judged' });
  }
  return { modules, unreadable };
};

/** One fixture file, scanned as a module of its own. */
export const scanLogCalls = (file: string, src: string): Finding[] => {
  const { modules, unreadable } = modulesOf([{ path: join(ROOT, file), file, src }]);
  return [...unreadable, ...scanModules(modules)];
};

/** For the tests that walk every server module: generous, so a slow runner is not a failure. */
const SCAN_TIMEOUT_MS = 30_000;

describe('server log lines name nobody and print no raw error (MICA-433)', () => {
  const files = walk(SERVER).map((path) => ({
    path,
    file: relative(ROOT, path),
    src: readFileSync(path, 'utf8')
  }));
  const { modules, unreadable } = modulesOf(files);

  // Whole-tree work: `files` and `modules` are read once, as the suite loads; each test below
  // walks every module again, under a timeout of its own rather than vitest's five seconds.
  it('scans a real set of files', { timeout: SCAN_TIMEOUT_MS }, () => {
    // An empty walk asserts nothing; the server has well over a hundred source files.
    expect(files.length).toBeGreaterThan(100);
    expect(unreadable).toEqual([]);
  });

  it(
    'knows every log wrapper, and lists no function that is not one',
    { timeout: SCAN_TIMEOUT_MS },
    () => {
      const relays = findWrappers(modules)
        .filter((w) => w.relay)
        .map((w) => `${w.file}:${w.name}`);
      expect(relays.sort()).toEqual([...WRAPPERS].sort());
    }
  );

  it('finds nothing in server/', { timeout: SCAN_TIMEOUT_MS }, () => {
    const findings = scanModules(modules);
    expect(findings.map((f) => `${f.file}:${f.line} ${f.problem}`)).toEqual([]);
  });
});

describe('the scan itself', () => {
  const scan = (src: string) => scanLogCalls('fixture.ts', src).map((f) => f.problem);
  /** Several fixture files scanned together, as `server/` is: imports resolve between them. */
  const scanFiles = (files: Record<string, string>) => {
    const { modules, unreadable } = modulesOf(
      Object.entries(files).map(([file, src]) => ({ path: join(ROOT, file), file, src }))
    );
    expect(unreadable).toEqual([]);
    return {
      wrappers: findWrappers(modules).map((w) => `${w.file}:${w.name}:${w.forwarded.join(',')}`),
      findings: scanModules(modules).map((f) => `${f.file}:${f.line} ${f.problem}`)
    };
  };

  it('fails a raw error, and passes it through reasonOf or traceOf', () => {
    expect(scan("console.error('[x] failed:', error);")).toEqual([
      "logs 'error' raw — use reasonOf()"
    ]);
    expect(scan('console.error(`[x] failed: ${(error as Error).message}`);')).toHaveLength(1);
    expect(scan("console.error('[x] failed:', reasonOf(error));")).toEqual([]);
    expect(scan("console.error('[x] failed:', traceOf(error));")).toEqual([]);
  });

  it('fails a bare or interpolated citizenid, and passes it through who', () => {
    expect(scan('console.log(`[x] ${citizenid} paid`);')).toEqual(["logs 'citizenid' — use who()"]);
    expect(scan("console.warn('[x]', player.citizenid);")).toHaveLength(1);
    expect(scan('console.log(`[x] ${who(citizenid)} paid ${amount}`);')).toEqual([]);
    // Read through, the field decides: a holder's row count names nobody.
    expect(scan('console.log(`${holder.rowCount} row(s)`);')).toEqual([]);
    expect(scan('console.log(`${holder.citizenid}`);')).toHaveLength(1);
    expect(scan('console.error(`failed: ${error.message}`);')).toHaveLength(1);
  });

  it('fails any identifier containing an identity, in any case, not only the exact word', () => {
    for (const name of [
      'targetCitizenId',
      'ownerCitizenid',
      'phoneId',
      'callerNumber',
      'deviceId',
      'device_id'
    ]) {
      expect(scan(`console.log(\`\${${name}}\`);`), name).toHaveLength(1);
    }
    // A constant and a builtin carry the word and hold no value.
    expect(scan('console.log(`${PHONE_NUMBERS_TABLE} ${Number(count)}`);')).toEqual([]);
  });

  it('fails a bracketed read of an identity, which only the text view can name', () => {
    expect(scan("console.log(`${row['citizenid']}`);")).toEqual(["logs 'citizenid' — use who()"]);
    expect(scan('console.log(row["device_id"]);')).toHaveLength(1);
    expect(scan("console.log(row['title']);")).toEqual([]);
    expect(scan("console.log(`[x] ${who(row['citizenid'])}`);")).toEqual([]);
  });

  it('judges code only: a word in a string, a comment or a key is not a value', () => {
    expect(scan("console.log('the citizenid error from', count); // error")).toEqual([]);
    expect(scan('console.log({ count, error: undefined }.count);')).toEqual([]);
  });

  it('finds a log wrapper and judges its calls at the arguments it hands on', () => {
    const src = [
      'const reportOnce = (key: string, message: string): void => {',
      '  if (said.has(key)) return;',
      '  said.add(key);',
      '  console.warn(message);',
      '};',
      'reportOnce(citizenid, `[x] fine`);',
      'reportOnce(`k`, `[x] ${player.citizenid} failed`);'
    ].join('\n');
    expect(scanFiles({ 'fixture.ts': src }).wrappers).toEqual(['fixture.ts:reportOnce:1']);
    // The key is never printed; the message is.
    expect(scan(src)).toEqual(["logs 'citizenid' — use who()"]);
  });

  it('finds an expression-bodied wrapper and a function declaration', () => {
    const src = [
      'const say = (line: string): void => console.log(line);',
      'export function complain(why: string) { console.error(`[x] ${why}`); }',
      'say(`${phone}`);',
      'complain(deviceId);'
    ].join('\n');
    expect(scanFiles({ 'fixture.ts': src }).wrappers).toEqual([
      'fixture.ts:say:0',
      'fixture.ts:complain:0'
    ]);
    expect(scan(src)).toHaveLength(2);
  });

  it('fails console.<level> handed on as a value, which nothing then judges (review)', () => {
    expect(scan('push().catch(console.error);')).toEqual([
      'hands console.error on as a value, so what it prints is never judged'
    ]);
    expect(scan('const say = console.warn.bind(console);')).toHaveLength(1);
    expect(scan('const log = console.log;')).toHaveLength(1);
    // A reasoned waiver lets one through; a string or a comment naming it is not code.
    expect(
      scan('// log-identity-ok: the value is a fixed string\nx.catch(console.error);')
    ).toEqual([]);
    expect(scan("const s = 'console.error'; // console.warn")).toEqual([]);
    // And the call itself is still judged as a call, not a reference.
    expect(scan('console.error(`[x] ${reasonOf(error)}`);')).toEqual([]);
  });

  it('finds a class method that logs, and judges this.method( and Class.method( calls', () => {
    const src = [
      'export class Bridge {',
      '  private warn(message: string): void {',
      '    console.warn(`[bridge] ${message}`);',
      '  }',
      '  static note(line: string) { console.log(line); }',
      '  go(player: P) {',
      '    this.warn(`lost ${player.citizenid}`);',
      '  }',
      '}',
      'Bridge.note(`${phone}`);'
    ].join('\n');
    const { wrappers, findings } = scanFiles({ 'fixture.ts': src });
    expect(wrappers).toEqual(['fixture.ts:Bridge.warn:0', 'fixture.ts:Bridge.note:0']);
    expect(findings).toEqual([
      "fixture.ts:7 logs 'citizenid' — use who()",
      "fixture.ts:10 logs 'phone' — use who()"
    ]);
  });

  it('follows a wrapper through another wrapper, to a fixed point', () => {
    const src = [
      // Outermost first, so one pass in source order cannot get there: only a fixed point does.
      'const outer = (what: string) => middle(`mica`, what);',
      'const middle = (tag: string, text: string) => base(`[${tag}] ${text}`);',
      'const base = (line: string) => console.error(line);',
      'outer(`${citizenid}`);',
      'middle(deviceId, `fine`);'
    ].join('\n');
    const { wrappers, findings } = scanFiles({ 'fixture.ts': src });
    expect(wrappers).toEqual(['fixture.ts:outer:0', 'fixture.ts:middle:0,1', 'fixture.ts:base:0']);
    expect(findings).toEqual([
      "fixture.ts:4 logs 'citizenid' — use who()",
      "fixture.ts:5 logs 'deviceId' — use who()"
    ]);
  });

  it('follows a wrapper through a named import, a re-export and an import * as', () => {
    const { findings } = scanFiles({
      'server/lib/log.ts': 'export const note = (line: string) => console.log(line);',
      'server/lib/index.ts': "export { note as say } from './log';\nexport * from './log';",
      'server/a.ts': "import { note } from './lib/log';\nnote(`${citizenid}`);",
      'server/b.ts': "import { say } from './lib/index';\nsay(`${phone}`);",
      'server/c.ts': "import * as log from './lib/log';\nlog.note(`${deviceId}`);",
      'server/d.ts': "import { note } from './lib/index';\nnote(`${phoneNumber}`);"
    });
    expect(findings.sort()).toEqual([
      "server/a.ts:2 logs 'citizenid' — use who()",
      "server/b.ts:2 logs 'phone' — use who()",
      "server/c.ts:2 logs 'deviceId' — use who()",
      "server/d.ts:2 logs 'phoneNumber' — use who()"
    ]);
  });

  it('takes a reasoned waiver for a name that is not a player, never for an error', () => {
    const waived = '// log-identity-ok: a job line, public\nconsole.log(`${line.number}`);';
    expect(scan(waived)).toEqual([]);
    expect(scan('// log-identity-ok:\nconsole.log(`${line.number}`);')).toHaveLength(1);
    expect(scan('// log-identity-ok: no\nconsole.error(`x`, error);')).toEqual([
      "logs 'error' raw — use reasonOf()"
    ]);
  });

  it('fails closed on a file it cannot read, and on a call that never closes', () => {
    expect(scan("const s = 'never closed;\nconsole.log(citizenid);")).toEqual([
      'could not be read; nothing in it is judged'
    ]);
    expect(scan('console.log(`a`, (count);')).toEqual(['a log call that never closes']);
  });
});
