// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * Languages an owner adds by dropping files in (MICA-235), no rebuild.
 *
 * `<resource>/locales/<lang>/<namespace>.json`, each a flat `{ key: string }` with keys written
 * without the namespace prefix — the shape an app's own `locales/en.json` has. A namespace is an
 * app id, `shell`, `ui` or `server`. `locales/en/` and `locales/de/` are generated from the
 * bundled sources; anything else is an owner's or a contributor's file.
 *
 * **Read once, at resource start, and cached.** The phone asks for a whole language at a time,
 * and a player switching language should not cost a disk read; an owner adding one restarts the
 * resource, which is what "drop files in, no rebuild" means here.
 *
 * **Nothing in here is fatal.** A missing folder is English only; a file that is not JSON, is
 * too big, names a namespace no app could have, or holds a value that is not a string is logged
 * and skipped, and the rest of the folder still loads. An owner's typo in `fr/notes.json` must
 * not take the phone down, nor take French away for every other app.
 *
 * Nothing here reads a player's input into a path. The folder's own entries are what gets
 * opened, and a language asked for over NUI is only ever a key into what was already read.
 */

/** A language tag as `normalizeLocale` (web/src/shell/state/locale.ts) accepts one. */
const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The rule `registerMessages` holds a namespace to. */
const NAMESPACE = /^[a-z][a-z0-9_]*$/;

/** Far above any real namespace — `ui` is the biggest bundled one, at a few kilobytes. */
export const MAX_FILE_BYTES = 256 * 1024;

export const FALLBACK_LANGUAGE = 'en';

/** How many missing or extra keys the start-up warning names before it just counts. */
const KEYS_NAMED = 10;

export type Messages = Record<string, string>;
export type Catalogs = Record<string, Messages>;

export interface LocaleStore {
  /** Every language with at least one valid file, `en` first and always, the rest sorted. */
  languages: string[];
  /** Language → namespace → messages. */
  catalogs: Map<string, Catalogs>;
}

/**
 * A tag as the phone spells it: language lowercased, the rest as given, '' when it is not one.
 * The same rule as the web's `normalizeLocale`, so a folder named `DE` and a convar of `de`
 * meet, and a `..` or a slash is simply not a tag.
 */
export const normalizeTag = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const [language, ...rest] = trimmed.split('-');
  const tag = [language.toLowerCase(), ...rest].join('-');
  return TAG.test(tag) ? tag : '';
};

const warn = (message: string): void => {
  console.warn(`[micaOS] locales: ${message}`);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One namespace file, or null (and a warning) when it cannot be used. */
const readNamespace = (path: string, label: string): Messages | null => {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    warn(`${label} could not be read (${String(error)}); skipped.`);
    return null;
  }
  if (size > MAX_FILE_BYTES) {
    warn(`${label} is ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit; skipped.`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`${label} is not valid JSON (${reason}); skipped.`);
    return null;
  }
  if (!isPlainObject(parsed)) {
    warn(`${label} is not a flat { "key": "text" } object; skipped.`);
    return null;
  }

  const messages: Messages = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key && typeof value === 'string') messages[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) {
    warn(
      `${label}: ${dropped.length} entr${dropped.length === 1 ? 'y is' : 'ies are'} not a ` +
        `string and ${dropped.length === 1 ? 'was' : 'were'} left out (${dropped.slice(0, KEYS_NAMED).join(', ')}).`
    );
  }
  return messages;
};

/**
 * Read a `locales/` folder. Never throws: whatever cannot be read is warned about and left out,
 * and a folder that is not there is English with no files.
 */
export const loadLocales = (root: string): LocaleStore => {
  const catalogs = new Map<string, Catalogs>();

  let entries: string[] = [];
  try {
    if (existsSync(root) && statSync(root).isDirectory()) entries = readdirSync(root);
  } catch (error) {
    warn(`${root} could not be listed (${String(error)}); only English is available.`);
  }

  for (const entry of entries.slice().sort()) {
    const dir = `${root}/${entry}`;
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const tag = normalizeTag(entry);
    if (!tag) {
      warn(`'${entry}' is not a language tag such as 'de' or 'pt-BR'; its folder is skipped.`);
      continue;
    }
    if (catalogs.has(tag)) {
      warn(`'${entry}' is the same language as another folder ('${tag}'); skipped.`);
      continue;
    }

    const namespaces: Catalogs = {};
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch (error) {
      warn(`${tag}/ could not be listed (${String(error)}); skipped.`);
      continue;
    }
    for (const file of files.slice().sort()) {
      if (!file.endsWith('.json')) continue;
      const namespace = file.slice(0, -'.json'.length);
      const label = `${entry}/${file}`;
      if (!NAMESPACE.test(namespace)) {
        warn(`${label}: '${namespace}' is not a namespace (lowercase, a-z0-9_); skipped.`);
        continue;
      }
      const messages = readNamespace(`${dir}/${file}`, label);
      if (messages) namespaces[namespace] = messages;
    }
    if (Object.keys(namespaces).length > 0) catalogs.set(tag, namespaces);
  }

  if (!catalogs.has(FALLBACK_LANGUAGE)) catalogs.set(FALLBACK_LANGUAGE, {});
  const others = [...catalogs.keys()].filter((l) => l !== FALLBACK_LANGUAGE).sort();
  return { languages: [FALLBACK_LANGUAGE, ...others], catalogs };
};

/**
 * What each non-English language is missing against `en`, and what it has that `en` does not:
 * one warning per language, per namespace a count and the first few keys. Returned as the
 * lines logged, so the start-up report and its test read the same thing.
 */
export const reportCoverage = (store: LocaleStore): string[] => {
  const en = store.catalogs.get(FALLBACK_LANGUAGE) ?? {};
  const lines: string[] = [];
  for (const language of store.languages) {
    if (language === FALLBACK_LANGUAGE) continue;
    const catalogs = store.catalogs.get(language) ?? {};
    const parts: string[] = [];
    const namespaces = new Set([...Object.keys(en), ...Object.keys(catalogs)]);
    for (const namespace of [...namespaces].sort()) {
      const base = Object.keys(en[namespace] ?? {});
      const own = catalogs[namespace] ?? {};
      const missing = base.filter((key) => !(key in own));
      const extra = Object.keys(own).filter((key) => !(key in (en[namespace] ?? {})));
      const name = (keys: string[]): string =>
        keys.slice(0, KEYS_NAMED).join(', ') + (keys.length > KEYS_NAMED ? ', …' : '');
      if (missing.length > 0) {
        parts.push(`${namespace}: ${missing.length} missing (${name(missing)})`);
      }
      if (extra.length > 0) {
        parts.push(`${namespace}: ${extra.length} not in en (${name(extra)})`);
      }
    }
    if (parts.length > 0) {
      lines.push(
        `'${language}' differs from en — missing keys fall back to English. ${parts.join('; ')}.`
      );
    }
  }
  return lines;
};

let store: LocaleStore | null = null;

/** `<resource>/locales`, or null outside FXServer (a test, a script). */
const resourceLocales = (): string | null => {
  if (typeof GetResourcePath !== 'function' || typeof GetCurrentResourceName !== 'function') {
    return null;
  }
  const path = GetResourcePath(GetCurrentResourceName());
  return path ? `${path}/locales` : null;
};

/** The cached folder, read on first use if resource start has not read it yet. */
export const locales = (): LocaleStore => {
  if (!store) {
    const root = resourceLocales();
    store = root ? loadLocales(root) : loadLocales('');
  }
  return store;
};

/** Read the folder now, replacing the cache, and warn about coverage. What resource start runs. */
export const reloadLocales = (root: string | null = resourceLocales()): LocaleStore => {
  store = loadLocales(root ?? '');
  for (const line of reportCoverage(store)) warn(line);
  return store;
};

/** One language's catalogs, or null when that language has no files. */
export const catalogFor = (raw: unknown): Catalogs | null => {
  const tag = normalizeTag(raw);
  if (!tag) return null;
  return locales().catalogs.get(tag) ?? null;
};

/** Test seam: forget the cache. */
export const __resetLocales = (): void => {
  store = null;
};

on('onResourceStart', (resourceName: string) => {
  if (typeof GetCurrentResourceName === 'function' && resourceName !== GetCurrentResourceName()) {
    return;
  }
  reloadLocales();
});
