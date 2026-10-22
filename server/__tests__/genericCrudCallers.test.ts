// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROUTES } from '@mica/shared/routes';

/**
 * Every generic CRUD event a service registers has a caller (MICA-414).
 *
 * `defineService` registers `get`, `create`, `update` and `delete` for a table unless the
 * declaration turns one off, so the default is four reachable net events per table whether or
 * not the phone ever sends them. A registered event is reachable regardless (§2.9), so an
 * uncalled one is attack surface with no feature behind it. `mica:server:blocklist:*` were three
 * of those: the table and `isBlocked` are real, but nothing in `web/` or `sdk/` ever listed,
 * added or removed a blocked number.
 *
 * `reachability.test.ts` pins a hand-picked list of events that must stay off. This is the
 * general rule it was standing in for: a generic event is registered only if `web/src` or `sdk`
 * reaches it, through one of the ways those reach the generic CRUD:
 *
 * - a row in `shared/routes.ts`, which `routes.test.ts` already holds to a real caller;
 * - `createCrudStore(…, { service: '<id>' })`, whose events are then server action names;
 * - `createPagedStore('<action>', { service: '<id>' })`, likewise;
 * - `useService('<id>').call('<action>', …)`, inline or through a local `() => useService(…)`.
 *
 * It is a scanner, and it fails closed in the direction that matters: a call site it cannot
 * read reports a live event as uncalled — loud, and fixed by teaching the scan the new shape —
 * never an uncalled one as live.
 */

const { dbMock, registeredServerEvents } = vi.hoisted(() => {
  // Inside `vi.hoisted` so it is installed before `import '../services'` registers anything.
  const events = new Set<string>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: unknown) => {
    events.add(event);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    registeredServerEvents: events
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import '../services';
import { registeredCustomActions } from '../lib/services';

const ROOT = join(__dirname, '..', '..');
const GENERIC = ['get', 'create', 'update', 'delete'] as const;

/**
 * Generic events that stay registered with no caller in `web/src` or `sdk`, each with why.
 *
 * Empty is the goal. An entry is a decision that an event with nothing calling it is still worth
 * being reachable — the bar is a caller outside this repo, not "it might be useful".
 */
const UNCALLED_BUT_KEPT: Readonly<Record<string, string>> = {};

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

/** `web/src` and `sdk`, minus tests and the browser mocks — those describe the surface. */
const sources = (): { file: string; text: string }[] =>
  [...walk(join(ROOT, 'web', 'src')), ...walk(join(ROOT, 'sdk'))]
    .filter((file) => !file.includes('/mocks/'))
    .map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, 'utf8') }));

/**
 * A source file as the scan reads it, three ways, all the same length so an index into one is an
 * index into the others:
 *
 * - `text` — comments blanked, strings kept: what the call patterns match against.
 * - `code` — strings, template text and regex literals blanked too: where a paren, or the start
 *   of a match, is code rather than something quoted.
 * - `ok` — false when the lexer met something it could not close (a string, a template, a block
 *   comment). Such a file credits nothing, so a lexer that lost its place reports live events as
 *   uncalled rather than crediting whatever text it misread.
 */
type Read = { text: string; code: string; ok: boolean };

/** Words after which a `/` opens a regex literal rather than dividing. */
const REGEX_AFTER = new Set(
  'return typeof instanceof in of new delete void throw case do else yield await'.split(' ')
);

/**
 * Lex TypeScript just far enough to tell code from strings and comments.
 *
 * Every string honours `\` escapes — skipping to the next quote character closed `'it\'s'` at
 * the escaped quote, and the rest of the file read inside out, so a call's argument bound ran on
 * past its own `)` and credited a neighbour's actions to it. Template literals resume code at
 * `${` and return to text at its matching `}`. A comment is only a comment outside a string, so
 * `'assets/*.png'` no longer swallows the code up to the next `*\/`, and `x();// …` (no space
 * before the slashes) is a comment, where the old whitespace-anchored pattern kept it as code.
 */
const lexScript = (src: string): Read => {
  const text = src.split('');
  const code = src.split('');
  const blank = (to: string[], from: number, end: number) => {
    for (let k = from; k < end; k++) if (to[k] !== '\n') to[k] = ' ';
  };
  const fail: Read = { text: src, code: src, ok: false };
  const resume: number[] = []; // the brace depth each open `${` closes back to
  let depth = 0;
  let prev = ''; // the last token: a word, a punctuation character, or 'value'

  // From inside a template's text: past its closing backtick, or past a `${`; -1 if neither.
  const templateEnd = (from: number): number => {
    for (let j = from; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return j + 1;
      else if (src[j] === '$' && src[j + 1] === '{') {
        resume.push(depth++);
        return j + 2;
      }
    }
    return -1;
  };
  // Past a regex literal's flags, or -1 when the line ends first — it was a division.
  const regexEnd = (from: number): number => {
    let inClass = false;
    for (let j = from + 1; j < src.length && src[j] !== '\n'; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '[') inClass = true;
      else if (src[j] === ']') inClass = false;
      else if (src[j] === '/' && !inClass) {
        for (j++; j < src.length && /[a-z]/i.test(src[j]!); j++);
        return j;
      }
    }
    return -1;
  };

  for (let i = 0; i < src.length;) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') {
      const newline = src.indexOf('\n', i);
      const end = newline < 0 ? src.length : newline;
      blank(text, i, end);
      blank(code, i, end);
      i = end;
    } else if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return fail;
      blank(text, i, close + 2);
      blank(code, i, close + 2);
      i = close + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== ch) return fail;
      blank(code, i, j + 1);
      i = j + 1;
      prev = 'value';
    } else if (ch === '`' || (ch === '}' && depth - 1 === resume.at(-1))) {
      if (ch === '}') depth = resume.pop()!;
      const end = templateEnd(i + 1);
      if (end < 0) return fail;
      blank(code, i, end);
      i = end;
      prev = src[end - 1] === '`' ? 'value' : '{';
    } else if (
      ch === '/' &&
      (/^[\w$]+$/.test(prev) ? REGEX_AFTER.has(prev) : !['value', ')', ']'].includes(prev))
    ) {
      const end = regexEnd(i);
      if (end < 0) {
        prev = '/';
        i++;
      } else {
        blank(code, i, end);
        i = end;
        prev = 'value';
      }
    } else if (/[\w$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      prev = src.slice(i, j);
      i = j;
    } else {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return resume.length > 0 ? fail : { text: text.join(''), code: code.join(''), ok: true };
};

/**
 * A `.svelte` file's `<script>` blocks are lexed; its markup is not, because an apostrophe in
 * prose (`Don't`) is not a quote. Markup only has its comments blanked, wherever they appear —
 * over-stripping there loses a caller, which is the safe direction.
 */
const readSource = (file: string, src: string): Read => {
  if (!file.endsWith('.svelte')) return lexScript(src);
  const markup = (s: string): Read => {
    const t = s.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|(?<=^|\s)\/\/[^\n]*/g, (m) =>
      m.replace(/[^\n]/g, ' ')
    );
    return { text: t, code: t, ok: true };
  };
  const parts: Read[] = [];
  let last = 0;
  for (const m of src.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g)) {
    const start = m.index + m[1]!.length;
    parts.push(markup(src.slice(last, start)), lexScript(m[2]!));
    last = start + m[2]!.length;
  }
  parts.push(markup(src.slice(last)));
  return {
    text: parts.map((p) => p.text).join(''),
    code: parts.map((p) => p.code).join(''),
    ok: parts.every((p) => p.ok)
  };
};

/**
 * The text of a call's argument list, from the `(` at `open` to its matching `)`, or `''` when
 * it never closes or `open` is not a paren in code.
 *
 * What bounds a `createCrudStore` or `createPagedStore` to its own call. A fixed window of
 * characters ran on into the next call, so a neighbour's `remove: 'delete'` was credited to the
 * first store's service. Parens are counted in `code`, where nothing quoted remains; an
 * unbalanced call reads as no call, which reports a live event as uncalled rather than the
 * reverse.
 */
const argumentsAt = ({ text, code }: Read, open: number): string => {
  if (code[open] !== '(') return '';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return '';
};

/** `service:action` for every generic CRUD call the scan can see, with where it saw it. */
const collectGenericCallers = (
  files: readonly { file: string; text: string }[] = sources(),
  routes: readonly { service: string; serverAction: string }[] = ROUTES
): Map<string, string> => {
  const found = new Map<string, string>();
  const add = (service: string, action: string, where: string) => {
    if (!found.has(`${service}:${action}`)) found.set(`${service}:${action}`, where);
  };

  for (const r of routes) add(r.service, r.serverAction, 'shared/routes.ts');

  for (const { file, text: raw } of files) {
    // A call in a comment is an example, not a caller: `sdk/lib/errors.ts`'s JSDoc shows one.
    // Nor is one quoted in a string; a match counts only where it starts in code.
    const read = readSource(file, raw);
    if (!read.ok) continue; // credits nothing; 'lexes every source file' names it
    const { text } = read;
    const inCode = (at: number) => read.code[at] === text[at];
    // The generic may not contain a paren, for the reason `routes.test.ts` gives: a lazy match
    // through one runs on into the next call. Newlines stay allowed — `contacts.ts` breaks one.
    for (const m of text.matchAll(/\bcreateCrudStore\s*(?:<[^()]*?>)?\s*\(/g)) {
      if (!inCode(m.index)) continue;
      const window = argumentsAt(read, m.index + m[0].length - 1);
      const service = /\bservice\s*:\s*['"](\w+)['"]/.exec(window)?.[1];
      if (!service) continue; // named NUI actions — a ROUTES row, counted above
      for (const e of window.matchAll(/\b(?:list|create|update|remove)\s*:\s*['"](\w+)['"]/g)) {
        add(service, e[1]!, file);
      }
    }

    for (const m of text.matchAll(/\bcreatePagedStore\s*(?:<[^()]*?>)?\s*(\()\s*['"](\w+)['"]/g)) {
      if (!inCode(m.index)) continue;
      const open = m.index + m[0].lastIndexOf('(');
      const service = /\bservice\s*:\s*['"](\w+)['"]/.exec(argumentsAt(read, open))?.[1];
      if (service) add(service, m[2]!, file);
    }

    // `const blabberService = () => useService('blabber')`, then `blabberService().call('create'`.
    const bound = new Map<string, string>();
    for (const m of text.matchAll(
      /\bconst\s+(\w+)\s*=\s*\(\)\s*=>\s*useService\(\s*['"](\w+)['"]\s*\)/g
    )) {
      if (inCode(m.index)) bound.set(m[1]!, m[2]!);
    }
    const CALL = String.raw`\s*\.call\s*(?:<[^()]*?>)?\s*\(\s*['"](\w+)['"]`;
    for (const m of text.matchAll(
      new RegExp(String.raw`\buseService\(\s*['"](\w+)['"]\s*\)` + CALL, 'g')
    )) {
      if (inCode(m.index)) add(m[1]!, m[2]!, file);
    }
    for (const m of text.matchAll(new RegExp(String.raw`\b(\w+)\(\)` + CALL, 'g'))) {
      const service = bound.get(m[1]!);
      if (service && inCode(m.index)) add(service, m[2]!, file);
    }
  }
  return found;
};

/** `service:action` for every generic CRUD event registered — custom actions of the same name excluded. */
const registeredGeneric = (): string[] => {
  const custom = new Set(registeredCustomActions());
  const out: string[] = [];
  for (const event of registeredServerEvents) {
    const m = /^mica:server:([a-z][a-z0-9_]*):(\w+)$/.exec(event);
    if (!m || !(GENERIC as readonly string[]).includes(m[2]!)) continue;
    const key = `${m[1]}:${m[2]}`;
    if (!custom.has(key)) out.push(key);
  }
  return out.toSorted();
};

const CALLERS = collectGenericCallers();
const REGISTERED = registeredGeneric();

describe('every generic CRUD event has a caller (MICA-414)', () => {
  it('lexes every source file to its end', () => {
    // A file the lexer cannot close credits nothing, which would surface as uncalled events with
    // no hint why; this names the file instead.
    const unread = sources()
      .filter(({ file, text }) => !readSource(file, text).ok)
      .map(({ file }) => file);
    expect(unread).toEqual([]);
  });

  it('sees enough of both sides that the check is not vacuous', () => {
    // Notes, Places, Contacts and Media alone are a dozen; the scan reaching none of them would
    // mean it read nothing, and every assertion below would pass on an empty set.
    expect(REGISTERED.length).toBeGreaterThan(15);
    for (const known of ['notes:get', 'places:delete', 'contacts:create', 'blabber:create']) {
      expect(CALLERS.has(known), known).toBe(true);
    }
  });

  it('registers no generic event that nothing in web/src or sdk calls', () => {
    const uncalled = REGISTERED.filter((key) => !CALLERS.has(key) && !(key in UNCALLED_BUT_KEPT));
    expect(uncalled.map((key) => `mica:server:${key}`)).toEqual([]);
  });

  it('keeps no allowlist entry the rule no longer needs', () => {
    // An entry whose event is gone, or has since gained a caller, is a stale reason that reads as
    // a live one.
    const stale = Object.keys(UNCALLED_BUT_KEPT).filter(
      (key) => !REGISTERED.includes(key) || CALLERS.has(key)
    );
    expect(stale).toEqual([]);
  });
});

/**
 * The scanner's own blind spots, on fixtures: each of these once credited a caller that does not
 * exist, which is the direction this file cannot afford — an uncalled event passing as called.
 */
describe('the caller scan', () => {
  const scan = (text: string) => collectGenericCallers([{ file: 'fixture.ts', text }], []);

  it('counts no call that only appears in a comment', () => {
    // `sdk/lib/errors.ts`'s JSDoc shows `useService('journal').call('create', …)` as an example.
    const found = scan(`
      /**
       * await useService('ghost').call('create', { title });
       */
      // useService('ghost').call('delete', { id });
      /* createCrudStore('Ghost', { list: 'get' }, { service: 'ghost' }) */
      export const live = () => useService('real').call('get', {});
    `);
    expect([...found.keys()].toSorted()).toEqual(['real:get']);
  });

  it("credits a store's events to its own service, never a neighbour's", () => {
    // A window of characters ran on past the first call's closing paren into the second's.
    const found = scan(`
      const a = createCrudStore('A', { list: 'get' }, { service: 'alpha' });
      const b = createCrudStore('B', { list: 'get', remove: 'delete' }, { service: 'beta' });
      const c = createCrudStore('C', { list: 'getC', remove: 'deleteC' });
      const d = createPagedStore('feed', {}); const e = createPagedStore('x', { service: 'eps' });
    `);
    expect([...found.keys()].toSorted()).toEqual(['alpha:get', 'beta:delete', 'beta:get', 'eps:x']);
  });

  it("does not let an escaped quote carry a store's bound past its own call", () => {
    // Closing `'it\'s'` at the escaped quote read the rest inside out: alpha's own `)` became
    // quoted, the `)` in `close` became code, and b's `remove: 'delete'` fell inside alpha's bound.
    const found = scan(String.raw`
      const a = createCrudStore('A', { list: 'get' }, { service: 'alpha', label: 'it\'s' });
      const b = createCrudStore('B', { list: 'getB', remove: 'delete' });
      const close = ')';
    `);
    expect([...found.keys()]).toEqual(['alpha:get']);
  });

  it("does not let a backtick inside a template's ${} carry a bound either", () => {
    // `${'`'}`: the quoted backtick closed the template early, with the same inside-out result.
    const found = scan(`
      const a = createCrudStore('A', { list: 'get' }, { service: 'alpha', label: \`a\${'\`'}b\` });
      const b = createCrudStore('B', { list: 'getB', remove: 'delete' });
      const close = ')';
    `);
    expect([...found.keys()]).toEqual(['alpha:get']);
  });

  it('reads a comment marker inside a string as text', () => {
    // A `/*` in a string stripped everything up to the next `*\/`, losing a real caller.
    const found = scan(`
      const glob = 'assets/*.png';
      export const live = () => useService('real').call('get', {});
      const url = \`https://example.invalid/*/\${glob}\`;
      export const also = () => useService('real').call('delete', {});
      const end = '*/';
    `);
    expect([...found.keys()].toSorted()).toEqual(['real:delete', 'real:get']);
  });

  it('counts no call in a comment with no space before it, or quoted in a string', () => {
    const found = scan(`
      live();// useService('ghost').call('create', {});
      const msg = "use useService('ghost').call('delete', …) instead";
      const tpl = \`\${x} createCrudStore('G', { list: 'get' }, { service: 'ghost' })\`;
      const y = \`\${useService('real').call('get', {})}\`; /* \${useService('ghost').call('get')} */
    `);
    expect([...found.keys()]).toEqual(['real:get']);
  });

  it('credits nothing from a file it cannot lex to the end', () => {
    // An unterminated string means the lexer lost its place; what it read so far is not trusted.
    expect(scan(`useService('real').call('get', {});\nconst s = 'never closed;\n`).size).toBe(0);
    expect(scan("useService('real').call('get', {});\nconst t = `${a}").size).toBe(0);
    expect(scan(`useService('real').call('get', {}); /* never closed`).size).toBe(0);
  });

  it('tells a regex literal from a division', () => {
    // `/'/` is a regex holding a quote, not a string opener; `a / b / c` is arithmetic.
    const found = scan(`
      const q = text.replace(/'/g, '').split(/[/']/);
      const r = (a / b) / c; // useService('ghost').call('get')
      export const live = () => useService('real').call('get', {});
    `);
    expect([...found.keys()]).toEqual(['real:get']);
  });

  it("lexes a .svelte file's script, and leaves an apostrophe in markup alone", () => {
    const found = collectGenericCallers(
      [
        {
          file: 'Fixture.svelte',
          text: [
            '<script lang="ts">',
            "  const go = () => useService('real').call('get', {}); // useService('ghost')",
            '</script>',
            "<p>Don't</p> <!-- useService('ghost').call('delete') -->",
            "<button onclick={() => useService('real').call('delete', {})}>x</button>"
          ].join('\n')
        }
      ],
      []
    );
    expect([...found.keys()].toSorted()).toEqual(['real:delete', 'real:get']);
  });
});
