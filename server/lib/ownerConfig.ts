// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseDefaultContacts,
  parseDefaultDock,
  parseDisabledApps,
  type DefaultContact,
  type OwnerConfig
} from '@mica/shared/ownerConfig';
import { PlayerFacingError } from './errors';

/**
 * The server's read of what an owner configures without editing TypeScript (MICA-234).
 *
 * `shared/ownerConfig.ts` owns what each value means; this owns where it comes from and what
 * the server does with it. Each convar is read per call rather than cached at boot, the same
 * as `mica_rate_limit`, so a `set` on a running server applies on the next request. A value
 * with entries the parser refused is named in one `[micaOS]` warning per distinct value, not
 * one per request, because a typo should be told once and a log should not grow with traffic.
 *
 * Every `GetConvar` below spells its name as a literal: `convars.test.ts` reads the name at
 * each call site, and a constant imported from `shared/` is one it cannot resolve.
 */

/** The value each convar last produced a warning check for, so a repeat stays quiet. */
const checked = new Map<string, string>();

const warnRejected = (convar: string, raw: string, rejected: string[], rule: string): void => {
  if (checked.get(convar) === raw) return;
  checked.set(convar, raw);
  if (rejected.length === 0) return;
  console.warn(
    `[micaOS] ${convar}: ignoring ${rejected.map((entry) => `'${entry}'`).join(', ')}. ${rule}`
  );
};

/** Apps the owner switched off. Settings is never among them; the parser refuses it. */
export const disabledApps = (): string[] => {
  const raw = GetConvar('mica_disabled_apps', '');
  const parsed = parseDisabledApps(raw);
  warnRejected(
    'mica_disabled_apps',
    raw,
    parsed.rejected,
    "Each entry is an app id such as 'mail'; 'settings' cannot be turned off."
  );
  return parsed.value;
};

/** The phone's four dock slots, or `[]` for the built-in dock. */
export const defaultDock = (): string[] => {
  const raw = GetConvar('mica_default_dock', '');
  const parsed = parseDefaultDock(raw);
  warnRejected(
    'mica_default_dock',
    raw,
    parsed.rejected,
    'The dock is at most four app ids, each once; a refused entry leaves its slot empty.'
  );
  return parsed.value;
};

/** What `shell:ownerConfig` answers. */
export const ownerConfig = (): OwnerConfig => ({
  disabledApps: disabledApps(),
  defaultDock: defaultDock()
});

export const isAppDisabled = (appId: string): boolean => disabledApps().includes(appId);

/**
 * Which app owns each service a disabled app takes down with it.
 *
 * **Only services no other app reaches.** Disabling an app refuses its server events so a
 * modified client cannot drive a feature the owner turned off, but most services are not one
 * app's: the phone and Messages read contacts, Camera and Blabber write media, Messages and
 * Settings read the bank balance. Refusing those because their namesake app is off would
 * break every other app that holds the facet, so they are listed below as never refused. The
 * source for "who reaches it" is each manifest's `permissions` and the web service that calls
 * the contract.
 *
 * A service id is not always its app's id, which is why this is a table rather than
 * `service === app`: Blabber's DMs are `blabber_dms`, and Bank's invoices are `invoices`.
 * `ownerConfig.test.ts` holds every registered service to exactly one of the two lists, so a
 * new service is a decision somebody makes rather than a default nobody noticed.
 */
export const APP_OF_SERVICE: Readonly<Record<string, string>> = {
  blabber: 'blabber',
  blabber_dms: 'blabber',
  hodlr: 'hodlr',
  // `bank` itself is not here: `useAccount` reads its transactions from Messages and Settings.
  invoices: 'bank',
  jobs: 'jobs',
  mail: 'mail',
  marketplace: 'marketplace',
  notes: 'notes',
  places: 'places'
};

/**
 * Services an owner's disabled list never refuses, whatever it names.
 *
 * The phone itself (`shell`, `phone`, `phones`, `phonenumbers`, `battery`, `signal`,
 * `lockscreen`, `notifications`, `settings`) and the privileged surface (`admin`, `reports`)
 * are not apps. The rest are data several apps share through a permission facet.
 */
export const NEVER_REFUSED_SERVICES: readonly string[] = [
  'accounts',
  'admin',
  'bank',
  'battery',
  'blocklist',
  'contacts',
  'conversations',
  'highscores',
  'lockscreen',
  'media',
  'messages',
  'music',
  'notifications',
  'phone',
  'phone_call_log',
  'phonenumbers',
  'phones',
  'reports',
  'settings',
  'shell',
  'signal'
];

/**
 * The disabled app this service belongs to, or null when a request to it may proceed.
 *
 * An unmapped service costs no convar read: the common case is a shared service, and the
 * request path pays for this on every call.
 */
export const disabledAppFor = (service: string): string | null => {
  const app = APP_OF_SERVICE[service];
  if (!app) return null;
  return isAppDisabled(app) ? app : null;
};

/** The refusal a player reads. Names the app id, never a table. */
export const appDisabledError = (app: string): PlayerFacingError =>
  new PlayerFacingError(`The ${app} app is turned off on this server.`, {
    key: 'server.endpoint.appDisabled',
    params: { app }
  });

export interface ResolvedContacts {
  value: DefaultContact[];
  rejected: string[];
  /** Why nothing could be read at all, or null. */
  problem: string | null;
}

/**
 * `mica_default_contacts` as inline JSON (it starts with `[`) or a path to a JSON file inside
 * this resource, read through `load`.
 *
 * A path is refused before it is read when it is absolute or climbs out with `..`.
 * `LoadResourceFile` is resource-relative already, and this is not a sandbox against the
 * owner who wrote `server.cfg`; it is so a value that plainly means a file somewhere else says
 * so, rather than quietly reading nothing. A missing, empty or unreadable file is a problem
 * reported to the caller, never a throw: a new phone must still be created.
 */
export const resolveDefaultContacts = (
  raw: string,
  load: (path: string) => string | null | undefined
): ResolvedContacts => {
  const text = raw.trim();
  if (!text) return { value: [], rejected: [], problem: null };
  if (text.startsWith('[')) return { ...parseDefaultContacts(text), problem: null };

  const path = text.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    return {
      value: [],
      rejected: [],
      problem: `'${text}' is not a path inside this resource; absolute paths and '..' are refused`
    };
  }

  let content: string | null | undefined;
  try {
    content = load(path);
  } catch {
    content = null;
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { value: [], rejected: [], problem: `could not read '${path}' from this resource` };
  }

  const parsed = parseDefaultContacts(content);
  // The parser refuses a whole document as one entry; reciting a file into the log is noise.
  if (parsed.value.length === 0 && parsed.rejected[0] === content.trim()) {
    return {
      value: [],
      rejected: [],
      problem: `'${path}' is not a JSON array of { "name", "number" }`
    };
  }
  return { ...parsed, problem: null };
};

/** The last value resolved, so a file is read once per value rather than once per phone. */
let contactsMemo: { raw: string; value: DefaultContact[] } | null = null;

/**
 * The contacts a new phone starts with, each held to the columns it lands in.
 *
 * `limits` are the `mica_contacts` column lengths, passed in by `services/Contacts.ts` so this
 * file never names another service's table. An entry too long for them is refused and named
 * rather than truncated: an owner's typo should be visible, and a clipped number dials nobody.
 * Memoized on the convar's value, so editing the file itself takes a restart.
 */
export const defaultContacts = (limits: { name: number; number: number }): DefaultContact[] => {
  const raw = GetConvar('mica_default_contacts', '');
  if (contactsMemo?.raw === raw) return contactsMemo.value;

  const resolved = resolveDefaultContacts(raw, (path) =>
    LoadResourceFile(GetCurrentResourceName(), path)
  );
  const value: DefaultContact[] = [];
  const rejected = [...resolved.rejected];
  for (const entry of resolved.value) {
    if (entry.name.length <= limits.name && entry.number.length <= limits.number) {
      value.push(entry);
    } else {
      rejected.push(JSON.stringify(entry));
    }
  }

  if (resolved.problem) {
    console.warn(
      `[micaOS] mica_default_contacts: ${resolved.problem}. New phones start with no contacts.`
    );
  }
  warnRejected(
    'mica_default_contacts',
    raw,
    rejected,
    `Each entry needs a "name" of at most ${limits.name} characters and a "number" of at ` +
      `most ${limits.number}.`
  );

  contactsMemo = { raw, value };
  return value;
};

/** Test seam: forget which values were warned about and the resolved contacts. */
export const __resetOwnerConfig = (): void => {
  checked.clear();
  contactsMemo = null;
};
