// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a server owner configures about the phone without editing TypeScript (MICA-234).
 *
 * Three convars, parsed here once so the server, the client and the mock transport cannot
 * disagree about what a value means. Each parser is total: a malformed value yields the
 * unconfigured answer plus the pieces it refused, never a throw, because a convar is a
 * free-form string and a typo in `server.cfg` must not stop the resource.
 *
 * The convar names are exported for prose and tests only. `server/__tests__/convars.test.ts`
 * reads the name at each `GetConvar*` call site, and an identifier imported from here is one
 * it cannot resolve, so every call site spells the name out as a literal.
 */

export const DISABLED_APPS_CONVAR = 'mica_disabled_apps';
export const DEFAULT_DOCK_CONVAR = 'mica_default_dock';
export const DEFAULT_CONTACTS_CONVAR = 'mica_default_contacts';

/** The same shape `shared/deepLink.ts` and both `publicApi.ts` files accept. */
const APP_ID = /^[a-z][a-z0-9_]*$/;

/**
 * Apps an owner may not disable. Settings holds Language, Display and Shortcuts; a phone
 * without it cannot be recovered from a bad choice the player made, so it stays.
 */
export const UNDISABLEABLE_APP_IDS: readonly string[] = ['settings'];

/** The phone's dock is four slots; the tablet's is not configurable by this convar. */
export const DEFAULT_DOCK_SLOTS = 4;

export interface Parsed<T> {
  value: T;
  /** Entries dropped, verbatim, so the caller can name them in one warning. */
  rejected: string[];
}

/** A comma list of app ids. Unset, blank or all-invalid is `[]`: nothing disabled. */
export const parseDisabledApps = (raw: unknown): Parsed<string[]> => {
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? '').split(',')) {
    const id = part.trim().toLowerCase();
    if (!id) continue;
    if (!APP_ID.test(id) || UNDISABLEABLE_APP_IDS.includes(id)) {
      rejected.push(part.trim());
      continue;
    }
    seen.add(id);
  }
  return { value: [...seen], rejected };
};

/**
 * A comma list of up to four app ids, positional — index is the slot, and an empty entry is
 * an empty slot (`phone,,camera`). Unset or blank is `[]`, meaning the built-in dock. A set
 * value is always padded to exactly four; ids past the fourth, bad shapes and repeats become
 * empty slots and are reported as rejected.
 */
export const parseDefaultDock = (raw: unknown): Parsed<string[]> => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: [], rejected: [] };
  const rejected: string[] = [];
  const seen = new Set<string>();
  const slots = text.split(',').map((part, index) => {
    const id = part.trim().toLowerCase();
    if (!id) return '';
    if (index >= DEFAULT_DOCK_SLOTS || !APP_ID.test(id) || seen.has(id)) {
      rejected.push(part.trim());
      return '';
    }
    seen.add(id);
    return id;
  });
  const value = slots.slice(0, DEFAULT_DOCK_SLOTS);
  while (value.length < DEFAULT_DOCK_SLOTS) value.push('');
  return { value, rejected };
};

export interface DefaultContact {
  name: string;
  number: string;
}

/**
 * Inline JSON only: an array of `{ name, number }`. Resolving a path to a file inside the
 * resource is the server's job (`LoadResourceFile`), which then hands the file's text here.
 * An entry missing either string is dropped; a document that is not an array is `[]`.
 */
export const parseDefaultContacts = (raw: unknown): Parsed<DefaultContact[]> => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: [], rejected: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { value: [], rejected: [text] };
  }
  if (!Array.isArray(doc)) return { value: [], rejected: [text] };
  const rejected: string[] = [];
  const value: DefaultContact[] = [];
  for (const entry of doc) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const number = typeof entry?.number === 'string' ? entry.number.trim() : '';
    if (name && number) value.push({ name, number });
    else rejected.push(JSON.stringify(entry));
  }
  return { value, rejected };
};

/** What `shell:ownerConfig` answers. Contacts are absent: the server seeds them into rows. */
export interface OwnerConfig {
  disabledApps: string[];
  /** `[]` means the built-in dock; otherwise exactly four entries, '' for an empty slot. */
  defaultDock: string[];
}
