// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, statSync } from 'node:fs';
import {
  brandingUrl,
  hasExtension,
  isSafeFileName,
  MAX_SOUND_BYTES,
  MAX_SOUND_STEM,
  MAX_SOUNDS,
  MAX_WALLPAPERS,
  OWNER_SOUND_PREFIX,
  parseBrandLogo,
  parseDefaultContacts,
  parseDefaultDock,
  parseDefaultFrame,
  parseDisabledApps,
  parseJobLines,
  parseThemeSeed,
  parseWallpapersFolder,
  SOUND_EXTENSIONS,
  soundLabel,
  soundStem,
  SOUNDS_FOLDER,
  WALLPAPER_EXTENSIONS,
  type DefaultContact,
  type FrameId,
  type JobLine,
  type OwnerConfig,
  type OwnerSound,
  type RefusedEntry
} from '@mica/shared/ownerConfig';
import { PlayerFacingError } from './errors';
import { appOfService } from './services';

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

// ─── branding (MICA-236) ─────────────────────────────────────────────────────

/** `#rrggbb` the theme is generated from, or null for the built-in theme. */
export const themeSeed = (): string | null => {
  const raw = GetConvar('mica_theme_seed', '');
  const parsed = parseThemeSeed(raw);
  warnRejected('mica_theme_seed', raw, parsed.rejected, "The seed is one colour, '#rrggbb'.");
  return parsed.value;
};

/** The frame a new player starts with. */
export const defaultFrame = (): FrameId => {
  const raw = GetConvar('mica_default_frame', '');
  const parsed = parseDefaultFrame(raw);
  warnRejected(
    'mica_default_frame',
    raw,
    parsed.rejected,
    "The frame is one of 'classic', 'notch' or 'punch'; using 'classic'."
  );
  return parsed.value;
};

/** `<resource>` on disk, or null outside FXServer. */
const resourceRoot = (): string | null => {
  if (typeof GetResourcePath !== 'function') return null;
  const path = GetResourcePath(GetCurrentResourceName());
  return path || null;
};

/** Each message said once per process, so a per-request read never grows the log. */
const said = new Set<string>();
const sayOnce = (message: string): void => {
  if (said.has(message)) return;
  said.add(message);
  console.warn(`[micaOS] ${message}`);
};

/**
 * The wallpaper folder's images, listed once per folder value and kept: the phone asks on
 * every open, and an owner adding a wallpaper restarts the resource anyway.
 *
 * Image files only, with a name the phone can put in a URL unescaped ([A-Za-z0-9._-], no
 * leading dot), sorted by name and capped at `MAX_WALLPAPERS`. Anything left out is named in
 * one warning. A folder that is not there is `[]` with nothing said — no wallpapers is the
 * ordinary state of a server that has not branded anything.
 */
const listed = new Map<string, string[]>();

const listWallpapers = (folder: string): string[] => {
  const root = resourceRoot();
  if (!root) return [];
  const dir = `${root}/${folder}`;
  let entries: string[];
  try {
    if (!existsSync(dir)) return [];
    if (!statSync(dir).isDirectory()) {
      sayOnce(`mica_wallpapers: '${folder}' is a file, not a folder; no wallpapers offered.`);
      return [];
    }
    entries = readdirSync(dir);
  } catch (error) {
    sayOnce(`mica_wallpapers: '${folder}' could not be listed (${String(error)}).`);
    return [];
  }

  const skipped: string[] = [];
  const images: string[] = [];
  for (const name of entries.slice().sort()) {
    let isFile = false;
    try {
      isFile = statSync(`${dir}/${name}`).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    if (!hasExtension(name, WALLPAPER_EXTENSIONS)) continue;
    if (!isSafeFileName(name)) {
      skipped.push(name);
      continue;
    }
    images.push(name);
  }
  if (skipped.length > 0) {
    sayOnce(
      `mica_wallpapers: skipping ${skipped.map((n) => `'${n}'`).join(', ')} in '${folder}'. ` +
        'A wallpaper file name is letters, digits, dot, underscore and hyphen.'
    );
  }
  if (images.length > MAX_WALLPAPERS) {
    sayOnce(
      `mica_wallpapers: '${folder}' has ${images.length} images; offering the first ` +
        `${MAX_WALLPAPERS} by name and leaving out ${images.slice(MAX_WALLPAPERS).join(', ')}.`
    );
  }
  const resource = GetCurrentResourceName();
  return images.slice(0, MAX_WALLPAPERS).map((name) => brandingUrl(resource, `${folder}/${name}`));
};

/** The owner's wallpapers as URLs the phone loads, or `[]`. */
export const wallpapers = (): string[] => {
  const raw = GetConvar('mica_wallpapers', '');
  const parsed = parseWallpapersFolder(raw);
  warnRejected(
    'mica_wallpapers',
    raw,
    parsed.rejected,
    "The folder must be under 'branding/' (for example 'branding/wallpapers'); '..', " +
      'backslashes and absolute paths are refused.'
  );
  let urls = listed.get(parsed.value);
  if (!urls) {
    urls = listWallpapers(parsed.value);
    listed.set(parsed.value, urls);
  }
  return urls;
};

/**
 * The owner's logo as a URL the phone loads, or null for the micaOS mark. A path the parser
 * accepts but that names no file warns once and answers null, so the phone shows its own mark
 * rather than a broken image.
 */
export const brandLogo = (): string | null => {
  const raw = GetConvar('mica_brand_logo', '');
  const parsed = parseBrandLogo(raw);
  warnRejected(
    'mica_brand_logo',
    raw,
    parsed.rejected,
    "The logo is one file under 'branding/' ending in .png, .jpg, .jpeg, .webp or .svg."
  );
  if (!parsed.value) return null;
  const root = resourceRoot();
  let found = false;
  try {
    found = root !== null && existsSync(`${root}/${parsed.value}`);
  } catch {
    found = false;
  }
  if (!found) {
    sayOnce(
      `mica_brand_logo: '${parsed.value}' is not a file in this resource; showing the micaOS mark.`
    );
    return null;
  }
  return brandingUrl(GetCurrentResourceName(), parsed.value);
};

// ─── sounds (MICA-256) ───────────────────────────────────────────────────────

/** The sound folder as listed, once per process: adding a sound restarts the resource. */
let soundsListed: OwnerSound[] | null = null;

/**
 * `branding/sounds/`, listed once. A file is offered when its name is safe to put in a URL
 * unescaped (the wallpaper rule), it ends in one of `SOUND_EXTENSIONS`, its stem is at most
 * `MAX_SOUND_STEM` characters and it is at most `MAX_SOUND_BYTES`, and no earlier file has its stem; the first `MAX_SOUNDS` of
 * those by name are offered. Unlike a wallpaper folder, where a stray file is ignored, every
 * file dropped here is named in a warning — anything an owner puts in this folder is meant as
 * a sound. The exception is a hidden file (`.gitkeep`, `.DS_Store`), which is never one. A
 * folder that is not there is `[]` with nothing said.
 */
const listSounds = (): OwnerSound[] => {
  const root = resourceRoot();
  if (!root) return [];
  const dir = `${root}/${SOUNDS_FOLDER}`;
  let entries: string[];
  try {
    if (!existsSync(dir)) return [];
    if (!statSync(dir).isDirectory()) {
      sayOnce(`sounds: '${SOUNDS_FOLDER}' is a file, not a folder; no owner sounds offered.`);
      return [];
    }
    entries = readdirSync(dir);
  } catch (error) {
    sayOnce(`sounds: '${SOUNDS_FOLDER}' could not be listed (${String(error)}).`);
    return [];
  }

  const skip = (name: string, why: string): void =>
    sayOnce(`sounds: skipping '${SOUNDS_FOLDER}/${name}': ${why}.`);
  const accepted: string[] = [];
  const stems = new Map<string, string>();
  for (const name of entries.slice().sort()) {
    if (name.startsWith('.')) continue;
    let stats: { isFile(): boolean; size: number } | null = null;
    try {
      stats = statSync(`${dir}/${name}`);
    } catch {
      stats = null;
    }
    if (!stats?.isFile()) {
      skip(name, 'not a file');
    } else if (!hasExtension(name, SOUND_EXTENSIONS)) {
      skip(name, `a sound is ${SOUND_EXTENSIONS.map((e) => `.${e}`).join(', ')}`);
    } else if (!isSafeFileName(name)) {
      skip(name, 'a sound file name is letters, digits, dot, underscore and hyphen');
    } else if (soundStem(name).length > MAX_SOUND_STEM) {
      skip(name, `the name before the extension is longer than ${MAX_SOUND_STEM} characters`);
    } else if (stats.size > MAX_SOUND_BYTES) {
      skip(name, `it is ${stats.size} bytes, over the ${MAX_SOUND_BYTES}-byte limit`);
    } else if (stems.has(soundStem(name))) {
      skip(name, `'${stems.get(soundStem(name))}' already has that name, and ids come from it`);
    } else {
      stems.set(soundStem(name), name);
      accepted.push(name);
    }
  }
  if (accepted.length > MAX_SOUNDS) {
    sayOnce(
      `sounds: '${SOUNDS_FOLDER}' has ${accepted.length} sounds; offering the first ` +
        `${MAX_SOUNDS} by name and leaving out ${accepted.slice(MAX_SOUNDS).join(', ')}.`
    );
  }
  const resource = GetCurrentResourceName();
  return accepted.slice(0, MAX_SOUNDS).map((name) => {
    const stem = soundStem(name);
    return {
      id: `${OWNER_SOUND_PREFIX}${stem}`,
      label: soundLabel(stem),
      url: brandingUrl(resource, `${SOUNDS_FOLDER}/${name}`)
    };
  });
};

/** The owner's ringtones and notification tones, or `[]`. */
export const sounds = (): OwnerSound[] => {
  soundsListed ??= listSounds();
  return soundsListed;
};

/** What `shell:ownerConfig` answers. */
export const ownerConfig = (): OwnerConfig => ({
  disabledApps: disabledApps(),
  defaultDock: defaultDock(),
  themeSeed: themeSeed(),
  defaultFrame: defaultFrame(),
  wallpapers: wallpapers(),
  brandLogo: brandLogo(),
  sounds: sounds()
});

/**
 * Read everything once at resource start, so a refused value is warned about when the owner is
 * watching the console rather than on some player's first open, and the wallpaper folder is
 * listed before anyone asks, and the sound folder with it.
 */
on('onResourceStart', (resourceName: string) => {
  if (resourceName !== GetCurrentResourceName()) return;
  ownerConfig();
});

export const isAppDisabled = (appId: string): boolean => disabledApps().includes(appId);

/**
 * Which services a disabled app takes down with it.
 *
 * **Only services no other app reaches**, and each says so itself: `app` on its
 * `defineService` or `ServiceEndpoint`, read back through `lib/services.ts`. Not a table here,
 * because this directory is core and an app the Store installs is not in this repository for
 * core to name (`sdk/coreBoundary.test.ts`). Disabling an app refuses its server events so a
 * modified client cannot drive a feature the owner turned off, but most services are not one
 * app's: the phone and Messages read contacts, Camera and Blabber write media, Messages and
 * Settings read the bank balance. Refusing those because their namesake app is off would break
 * every other app that holds the facet, so they declare no app and are listed below. The
 * source for "who reaches it" is each manifest's `permissions` and the web service that calls
 * the contract.
 *
 * A service id is not always its app's id, which is why it is a declaration rather than
 * `service === app`: Blabber's DMs are `blabber_dms`, Bank's invoices are `invoices`, and
 * Snek's board is `highscores`. `bank` itself declares no app: `useAccount` reads its
 * transactions from Messages and Settings.
 */

/**
 * Services an owner's disabled list never refuses, whatever it names: every registered service
 * that declares no app.
 *
 * A list rather than the silent default, so a forgotten declaration still fails a test —
 * `ownerConfig.test.ts` holds every registered service to declaring an app or appearing here,
 * never both. The phone itself (`shell`, `phone`, `phones`, `phonenumbers`, `battery`,
 * `signal`, `lockscreen`, `notifications`, `settings`) and the privileged surface (`admin`,
 * `reports`) are not apps. The rest are data several apps share through a permission facet.
 * It names no add-on, and must not.
 */
export const NEVER_REFUSED_SERVICES: readonly string[] = [
  // Its contract serves social add-ons outside this repo; one app being off must not refuse them.
  'accounts',
  'admin',
  'bank',
  'battery',
  'blocklist',
  'contacts',
  'conversations',
  // `micaimport`'s ledger (MICA-233): a table with no actions, and no app's.
  'importledger',
  'lockscreen',
  'media',
  'messages',
  'music',
  'notifications',
  'phone',
  'phone_call_log',
  'phonenumbers',
  'phones',
  // A player's own data (MICA-168): export and delete are never switched off.
  'privacy',
  'reports',
  'settings',
  'shell',
  'signal'
];

/**
 * The disabled app this service belongs to, or null when a request to it may proceed.
 *
 * A service that declared no app costs no convar read: the common case is a shared service,
 * and the request path pays for this on every call.
 */
export const disabledAppFor = (service: string): string | null => {
  const app = appOfService(service);
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
  const source = readJsonSource(raw, load);
  if (source.problem) return { value: [], rejected: [], problem: source.problem };
  if (!source.text) return { value: [], rejected: [], problem: null };
  if (source.path === null) return { ...parseDefaultContacts(source.text), problem: null };

  const parsed = parseDefaultContacts(source.text);
  // The parser refuses a whole document as one entry; reciting a file into the log is noise.
  if (parsed.value.length === 0 && parsed.rejected[0] === source.text.trim()) {
    return {
      value: [],
      rejected: [],
      problem: `'${source.path}' is not a JSON array of { "name", "number" }`
    };
  }
  return { ...parsed, problem: null };
};

/**
 * An owner convar that holds a JSON array inline (it starts with `[`) or a path to a JSON file
 * inside this resource, read through `load` — `mica_default_contacts` and `mica_job_lines`.
 *
 * A path is refused before it is read when it is absolute or climbs out with `..`.
 * `LoadResourceFile` is resource-relative already, and this is not a sandbox against the
 * owner who wrote `server.cfg`; it is so a value that plainly means a file somewhere else says
 * so, rather than quietly reading nothing. A missing, empty or unreadable file is a problem
 * reported to the caller, never a throw, and so is a value starting with `{`, which is inline
 * JSON missing its array. `path` is null for inline JSON and for a blank value.
 */
const readJsonSource = (
  raw: string,
  load: (path: string) => string | null | undefined
): { text: string; path: string | null; problem: string | null } => {
  const text = raw.trim();
  if (!text || text.startsWith('[')) return { text, path: null, problem: null };
  // Plainly JSON, not a path: one entry written without its brackets. Said as that, rather
  // than as a file named `{"number": …}` that could not be read.
  if (text.startsWith('{')) {
    return {
      text: '',
      path: null,
      problem: 'inline JSON must be an array; wrap the entry in [ ]'
    };
  }

  const path = text.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    return {
      text: '',
      path,
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
    return { text: '', path, problem: `could not read '${path}' from this resource` };
  }
  return { text: content, path, problem: null };
};

export interface ResolvedJobLines {
  value: JobLine[];
  rejected: RefusedEntry[];
  /** Why nothing could be read at all, or null. */
  problem: string | null;
}

/**
 * `mica_job_lines` (MICA-307) as inline JSON or a path to a JSON file inside this resource,
 * the same two forms `mica_default_contacts` takes. Never throws: a document that cannot be
 * read at all is a `problem`, and each entry the parser refused is named with its reason.
 */
export const resolveJobLines = (
  raw: string,
  load: (path: string) => string | null | undefined
): ResolvedJobLines => {
  const source = readJsonSource(raw, load);
  if (source.problem) return { value: [], rejected: [], problem: source.problem };
  const parsed = parseJobLines(source.text);
  // A whole document refused is one problem, not an entry: name the file, not its contents.
  const whole = parsed.rejected.length === 1 && parsed.rejected[0].entry === source.text.trim();
  if (parsed.value.length === 0 && whole) {
    const where = source.path === null ? 'the value' : `'${source.path}'`;
    return { value: [], rejected: [], problem: `${where} is ${parsed.rejected[0].reason}` };
  }
  return { ...parsed, problem: null };
};

/**
 * The raw `mica_job_lines` value. Read per call, never cached: `lib/jobLines.ts` compares it
 * against the last value it synced, so a `set` on a live server applies without a restart.
 */
export const jobLinesConvar = (): string => GetConvar('mica_job_lines', '');

/** `mica_job_lines`, resolved, with a path read from this resource. */
export const readJobLines = (raw: string): ResolvedJobLines =>
  resolveJobLines(raw, (path) => LoadResourceFile(GetCurrentResourceName(), path));

/**
 * The most default contacts a new phone is seeded with.
 *
 * Each is its own insert against a phone that did not exist a moment ago, so an owner's file of
 * thousands would be thousands of writes per new phone. Entries past the cap are refused and
 * named in the one warning, like any other, rather than silently dropped.
 */
export const MAX_DEFAULT_CONTACTS = 50;

/** The last value resolved, so a file is read once per value rather than once per phone. */
let contactsMemo: { raw: string; value: DefaultContact[] } | null = null;

/**
 * The contacts a new phone starts with, each held to the columns it lands in, and at most
 * `MAX_DEFAULT_CONTACTS` of them — the first that fit, in the owner's order.
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
    const fits = entry.name.length <= limits.name && entry.number.length <= limits.number;
    if (fits && value.length < MAX_DEFAULT_CONTACTS) {
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
      `most ${limits.number}, and a new phone gets at most ${MAX_DEFAULT_CONTACTS} of them.`
  );

  contactsMemo = { raw, value };
  return value;
};

/** Test seam: forget which values were warned about and the resolved contacts. */
export const __resetOwnerConfig = (): void => {
  checked.clear();
  contactsMemo = null;
  listed.clear();
  soundsListed = null;
  said.clear();
};
