// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a server owner configures about the phone without editing TypeScript (MICA-234).
 *
 * The owner convars — three from MICA-234 and four branding ones from MICA-236 — parsed here
 * once so the server, the client and the mock transport cannot disagree about what a value
 * means. Each parser is total: a malformed value yields the
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
export const THEME_SEED_CONVAR = 'mica_theme_seed';
export const WALLPAPERS_CONVAR = 'mica_wallpapers';
export const BRAND_LOGO_CONVAR = 'mica_brand_logo';
export const DEFAULT_FRAME_CONVAR = 'mica_default_frame';

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

// ─── job lines (MICA-307) ────────────────────────────────────────────────────

export const JOB_LINES_CONVAR = 'mica_job_lines';

/** The most players one call may ring at once, whoever asks: a script's verdict or a job line. */
export const RING_MAX = 32;

/** How many staff a job line rings when the owner does not say. */
export const DEFAULT_MAX_RING = 10;

/** The longest label a line may carry, for the parser and the registry alike. */
export const LINE_LABEL_MAX = 40;

/** A framework job key, as the registry's `job` option takes it: `'police'`. */
const JOB_KEY = /^[a-z][a-z0-9_]*$/;

/** One phone number micaOS answers for a set of framework jobs (MICA-307). */
export interface JobLine {
  number: string;
  /** Null when the owner gave none; the phone then shows the number. */
  label: string | null;
  /** Lower_snake_case framework job names, at least one, each once. */
  jobs: string[];
  /** Ring only staff the framework does not say are off duty. Defaults to true. */
  requireDuty: boolean;
  /** At most this many staff ring, a whole number 1..`RING_MAX`. Defaults to `DEFAULT_MAX_RING`. */
  maxRing: number;
  /** Whether a player may block the line's texts. Defaults to true. */
  blockable: boolean;
}

/** An entry the parser refused, verbatim, with why — so the warning can say both. */
export interface RefusedEntry {
  entry: string;
  reason: string;
}

const JOB_LINE_KEYS: readonly string[] = [
  'number',
  'label',
  'jobs',
  'requireDuty',
  'maxRing',
  'blockable'
];

/** One entry, or the reason it is refused. Never throws. */
const jobLineFrom = (entry: unknown): JobLine | string => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  const raw = entry as Record<string, unknown>;

  // Refused rather than ignored: `"requireduty": false` read as the default would ring off-duty
  // staff's phones with nothing in the console to say why.
  const unknown = Object.keys(raw).filter((key) => !JOB_LINE_KEYS.includes(key));
  if (unknown.length > 0) return `unknown key ${unknown.map((k) => `"${k}"`).join(', ')}`;

  const number = typeof raw.number === 'string' ? raw.number.trim() : '';
  if (!number) return '"number" is required and must be a string';

  let label: string | null = null;
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') return '"label" must be a string';
    label = raw.label.trim() || null;
    if (label && label.length > LINE_LABEL_MAX) {
      return `"label" must be at most ${LINE_LABEL_MAX} characters`;
    }
  }

  if (!Array.isArray(raw.jobs) || raw.jobs.length === 0) {
    return '"jobs" is required: a non-empty array of job names';
  }
  const jobs: string[] = [];
  for (const job of raw.jobs) {
    if (typeof job !== 'string' || !JOB_KEY.test(job)) {
      return `"jobs" holds ${JSON.stringify(job)}; a job name is lower_snake_case, like "police"`;
    }
    if (!jobs.includes(job)) jobs.push(job);
  }

  if (raw.requireDuty !== undefined && typeof raw.requireDuty !== 'boolean') {
    return '"requireDuty" must be true or false';
  }
  if (raw.blockable !== undefined && typeof raw.blockable !== 'boolean') {
    return '"blockable" must be true or false';
  }

  // Refused, not clamped, like every other bad value: a `maxRing` of 50 quietly ringing 32
  // is a number the owner wrote and the server did not do, with nothing to say so.
  let maxRing = DEFAULT_MAX_RING;
  if (raw.maxRing !== undefined) {
    const n = raw.maxRing;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > RING_MAX) {
      return `"maxRing" must be a whole number from 1 to ${RING_MAX}`;
    }
    maxRing = n;
  }

  return {
    number,
    label,
    jobs,
    requireDuty: raw.requireDuty !== false,
    maxRing,
    blockable: raw.blockable !== false
  };
};

/**
 * Inline JSON only: an array of job line entries (MICA-307). A path to a file is resolved by the
 * server, which hands the file's text here, as for `parseDefaultContacts`.
 *
 * Each entry stands alone: one that is malformed is refused with its reason and the rest are
 * kept, and a second entry for a number already taken is refused as a duplicate. A document
 * that is not an array is refused whole. Unset or blank is `[]`: no job lines.
 */
export const parseJobLines = (raw: unknown): { value: JobLine[]; rejected: RefusedEntry[] } => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: [], rejected: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { value: [], rejected: [{ entry: text, reason: 'not valid JSON' }] };
  }
  if (!Array.isArray(doc)) {
    return { value: [], rejected: [{ entry: text, reason: 'not a JSON array' }] };
  }
  const value: JobLine[] = [];
  const rejected: RefusedEntry[] = [];
  for (const entry of doc) {
    const line = jobLineFrom(entry);
    if (typeof line === 'string') {
      rejected.push({ entry: JSON.stringify(entry) ?? String(entry), reason: line });
    } else if (value.some((held) => held.number === line.number)) {
      rejected.push({
        entry: JSON.stringify(entry),
        reason: `an earlier entry already has "${line.number}"`
      });
    } else {
      value.push(line);
    }
  }
  return { value, rejected };
};

// ─── branding (MICA-236) ─────────────────────────────────────────────────────

/** The phone frames an owner may pick as the default. The player can still change theirs. */
export const FRAME_IDS = ['classic', 'notch', 'punch'] as const;
export type FrameId = (typeof FRAME_IDS)[number];
export const DEFAULT_FRAME: FrameId = 'classic';

/**
 * The one folder owner images may come from. FiveM serves it from the resource, and nothing
 * outside it is ever named in a URL the phone loads — a path that climbs out, is absolute, uses
 * a backslash or names a drive is refused rather than normalised.
 */
export const BRANDING_ROOT = 'branding';
export const DEFAULT_WALLPAPERS_FOLDER = 'branding/wallpapers';

/** Formats a wallpaper may be. The logo may also be an SVG. */
export const WALLPAPER_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp'];
export const LOGO_EXTENSIONS: readonly string[] = [...WALLPAPER_EXTENSIONS, 'svg'];

/** Most wallpapers the phone offers from the folder; the rest are left out and named. */
export const MAX_WALLPAPERS = 50;

/** One path segment or file name: letters, digits, dot, underscore, hyphen; no leading dot. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export const isSafeFileName = (name: string): boolean => SAFE_SEGMENT.test(name);

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

export const hasExtension = (name: string, allowed: readonly string[]): boolean =>
  allowed.includes(extensionOf(name));

/**
 * A resource-relative path under `branding/`, or null. Every segment must be a safe name, so
 * `..`, `.`, empty segments, backslashes, a leading slash, a drive (`C:`) and a scheme are all
 * refused by the same rule. A trailing slash is dropped.
 */
export const brandingPath = (raw: string): string | null => {
  const text = raw.trim().replace(/\/+$/, '');
  if (!text || text.includes('\\')) return null;
  const segments = text.split('/');
  if (segments[0] !== BRANDING_ROOT) return null;
  if (!segments.every((segment) => SAFE_SEGMENT.test(segment))) return null;
  return segments.join('/');
};

/** `https://cfx-nui-<resource>/<path>`: how CEF loads a file the resource serves. */
export const brandingUrl = (resource: string, path: string): string =>
  `https://cfx-nui-${resource}/${path}`;

// ─── sounds (MICA-256) ───────────────────────────────────────────────────────

/**
 * The one folder owner ringtones and notification tones come from. Fixed, with no convar: the
 * packer ships nothing under it, so an update never overwrites an owner's file.
 */
export const SOUNDS_FOLDER = 'branding/sounds';

/**
 * Formats Chromium 103 decodes without proprietary codecs: Ogg Vorbis/Opus, MP3 and WAV. That
 * FiveM's CEF build decodes each of them is unverified — AAC (`.m4a`) is left out because it
 * needs the proprietary codecs a CEF build may not carry.
 */
export const SOUND_EXTENSIONS: readonly string[] = ['ogg', 'oga', 'opus', 'mp3', 'wav'];

/** Most sounds the phone offers from the folder; the rest are left out and named. */
export const MAX_SOUNDS = 30;

/** Largest sound file offered, in bytes (1 MiB). A tone is seconds long; more is a song. */
export const MAX_SOUND_BYTES = 1024 * 1024;

/** What an owner sound's id starts with, so it can never collide with a built-in tone id. */
export const OWNER_SOUND_PREFIX = 'owner:';

/**
 * Longest file stem an owner sound may have. The id `owner:<stem>` is what the player's
 * ringtone and notification tone store (`mica_settings.setting_value`, text) and what a
 * per-contact ringtone stores in `mica_contacts.ringtone`, whose width is `MAX_OWNER_SOUND_ID`.
 */
export const MAX_SOUND_STEM = 48;

/** The longest owner sound id: `owner:` and a stem at the cap. The column width that stores one. */
export const MAX_OWNER_SOUND_ID = OWNER_SOUND_PREFIX.length + MAX_SOUND_STEM;

/** A stem the server would have listed: the file-name charset, no leading dot, within the cap. */
const OWNER_STEM = new RegExp(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,${MAX_SOUND_STEM - 1}}$`);

/** `owner:<stem>` in the shape the server lists. Says nothing about whether the file exists. */
export const isOwnerSoundId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith(OWNER_SOUND_PREFIX) &&
  OWNER_STEM.test(value.slice(OWNER_SOUND_PREFIX.length));

/**
 * The phone's five synthesised ringtones. Mirrors `RingtoneId` in `sdk/vocabulary/audio.ts`;
 * `shared/` cannot import from the SDK, so the two are kept in step by hand.
 */
export const BUILT_IN_RINGTONE_IDS: readonly string[] = [
  'classic',
  'chime',
  'beacon',
  'pulse',
  'ascent'
];

/**
 * A value a ringtone may store: a built-in id or an owner sound id. The server holds a
 * contact's `ringtone` column to it (`services/Contacts.ts`), so a payload cannot park
 * arbitrary text there; the phone uses it before playing one.
 */
export const isRingtoneValue = (value: unknown): value is string =>
  (typeof value === 'string' && BUILT_IN_RINGTONE_IDS.includes(value)) || isOwnerSoundId(value);

/** One owner sound, as `shell:ownerConfig` answers it. */
export interface OwnerSound {
  /** `owner:<file stem>`. */
  id: string;
  /** The stem with `-` and `_` read as spaces. */
  label: string;
  /** `https://cfx-nui-<resource>/branding/sounds/<file>`. */
  url: string;
}

/** A file name's stem: everything before the last dot. */
export const soundStem = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
};

/** How a stem reads in a picker: `-` and `_` become spaces. */
export const soundLabel = (stem: string): string => stem.replace(/[-_]/g, ' ');

/** `#rrggbb`, answered lowercase. Unset or blank is null: the built-in theme. */
export const parseThemeSeed = (raw: unknown): Parsed<string | null> => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, rejected: [] };
  return /^#[0-9a-fA-F]{6}$/.test(text)
    ? { value: text.toLowerCase(), rejected: [] }
    : { value: null, rejected: [text] };
};

/** One of `FRAME_IDS`, any case. Unset, blank or unknown is `classic`. */
export const parseDefaultFrame = (raw: unknown): Parsed<FrameId> => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: DEFAULT_FRAME, rejected: [] };
  const id = text.toLowerCase();
  return (FRAME_IDS as readonly string[]).includes(id)
    ? { value: id as FrameId, rejected: [] }
    : { value: DEFAULT_FRAME, rejected: [text] };
};

/** A folder under `branding/`. Unset, blank or refused is `branding/wallpapers`. */
export const parseWallpapersFolder = (raw: unknown): Parsed<string> => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: DEFAULT_WALLPAPERS_FOLDER, rejected: [] };
  const path = brandingPath(text);
  return path
    ? { value: path, rejected: [] }
    : { value: DEFAULT_WALLPAPERS_FOLDER, rejected: [text] };
};

/**
 * A file under `branding/` ending in one of `LOGO_EXTENSIONS`. Unset or blank is null, the
 * micaOS mark. Whether the file exists is the server's question, not this parser's.
 */
export const parseBrandLogo = (raw: unknown): Parsed<string | null> => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, rejected: [] };
  const path = brandingPath(text);
  return path && path !== BRANDING_ROOT && hasExtension(path, LOGO_EXTENSIONS)
    ? { value: path, rejected: [] }
    : { value: null, rejected: [text] };
};

/** What `shell:ownerConfig` answers. Contacts are absent: the server seeds them into rows. */
export interface OwnerConfig {
  disabledApps: string[];
  /** `[]` means the built-in dock; otherwise exactly four entries, '' for an empty slot. */
  defaultDock: string[];
  /** `#rrggbb` the theme is generated from, or null for the built-in theme (MICA-236). */
  themeSeed: string | null;
  /** The frame a new player starts with (MICA-236). */
  defaultFrame: FrameId;
  /** Absolute `https://cfx-nui-<resource>/branding/…` URLs, sorted by file name (MICA-236). */
  wallpapers: string[];
  /** The same URL form, or null for the micaOS mark (MICA-236). */
  brandLogo: string | null;
  /** Owner ringtones and notification tones from `branding/sounds/`, sorted by file name (MICA-256). */
  sounds: OwnerSound[];
}
