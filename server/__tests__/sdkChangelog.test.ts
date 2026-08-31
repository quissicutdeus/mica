import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SDK_CONTRACT_VERSION } from '../../sdk/version';
import { ALL_PERMISSIONS } from '../../sdk/manifest';
import { PERMISSION_OF } from '../../sdk/permissions';

/**
 * The SDK half of the CHANGELOG is written, enforced (MICA-125).
 *
 * `changelog.test.ts` beside this file holds the same document to the two schema changes
 * that put `gphoneschema apply` in front of a **server owner**. This one holds it to the
 * changes that reach somebody who is not on this machine at all: the author of a
 * `core: false` add-on, deciding whether their bundle still compiles and whether its
 * manifest still asks for the right things.
 *
 * A sibling rather than a third `describe` in that file, for one reason: the two read
 * different sources and answer to different readers, and the owner-facing gate should not
 * fail because an SDK hook moved. They share the changelog and nothing else. What they do
 * share deliberately is the shape — a frozen baseline, a code-span matcher, and a block of
 * probes that drive both matchers with input this repo does not have — so somebody who has
 * read one can read the other.
 *
 * ## What it keys on, and why not the obvious thing
 *
 * `SDK_CONTRACT_VERSION` is the number an add-on reads, and the honest reflex is to gate on
 * it alone. That is arm 1 below and it is not enough, because **the pin moves only on a
 * break**. An addition never moves it (`sdk/version.ts` says so outright, and
 * `publicSurface.test.ts` lets additions through on purpose), and an addition is exactly
 * what an add-on author wants the file for: a hook they can now call, a permission their
 * manifest now has to declare.
 *
 * The frozen baselines in `publicSurface.test.ts` are the other obvious candidate and are
 * also not it. They are re-frozen when a **removal** forces it; an addition passes that gate
 * untouched, and the two additions written into it by hand (`focusTrap`, `messageOf`) are
 * called out there as the exception rather than the rule. Keying on a list that need not
 * move for the change you are trying to catch is keying on nothing.
 *
 * So arm 2 freezes the **capability table** instead — `PERMISSION_OF` from
 * `sdk/permissions.ts`, one row per host hook, plus `ALL_PERMISSIONS` from
 * `sdk/manifest.ts`. Three reasons that is the right list:
 *
 *   1. **It is the surface an add-on has to act on.** A new row is a new thing to call; a
 *      lost row is a call that stops resolving; a changed row is a call that still resolves
 *      and is now refused unless the manifest declares something new. All three are work for
 *      somebody outside this repo, and all three are one line to write down.
 *   2. **It cries wolf about nothing.** The alternative — freezing every exported name — puts
 *      a changelog entry between a contributor and `git add sdk/ui/icons/PizzaIcon.svelte`,
 *      because `scripts/generate-barrels.js` grows the surface on its own.
 *      `publicSurface.test.ts` already records that a gate demanding paperwork for a new icon
 *      is a gate somebody switches off, and a switched-off gate is a silent failure with
 *      extra steps.
 *   3. **It cannot go stale without something else failing first.** `permissions.test.ts`
 *      proves `PERMISSION_OF` against the real source in both directions — every host hook
 *      has a row, and every row names an export that exists. So this file is reading a table
 *      that is already held to reality, rather than a second transcription of it.
 *
 * The worked case is MICA-127, in the file above under "Action required": eight read hooks
 * grew a `-write` half and eight permissions came with them. That change moved neither the
 * pin nor a `publicSurface.test.ts` baseline — every old name was still exported, and the
 * setters that moved were **properties of a hook's return object**, which no gate in this
 * tree reads. Arm 2 sees it as sixteen new rows and eight new members and demands the entry.
 *
 * ## What this cannot see, said plainly
 *
 * - **Anything on the published surface that is not a host hook or a permission.** A new
 *   component, a new icon, a new util, a new exported type: none of them appear here. A
 *   *break* in one moves the pin and arm 1 catches it; an *addition* is unannounced by
 *   design, per reason 2 above.
 * - **The shape of what a hook returns.** MICA-127 is only caught because it also added
 *   rows. A setter quietly dropped from `useTheme()`'s return object with no new hook beside
 *   it moves nothing here and nothing in `publicSurface.test.ts` either. That is the largest
 *   gap of the two files taken together, and it is not closed anywhere; a return-object
 *   contract is worth its own ticket rather than a matcher bolted onto this one.
 * - **Whether the pin is right.** Arm 1 asks that the number currently exported is written
 *   down. It cannot ask whether somebody should have bumped it — that judgement lives in
 *   `publicSurface.test.ts`, which fails a removal until the pin moves and the baselines are
 *   re-frozen in the same commit.
 * - **Whether the prose is any good.** As next door: the matcher asks that the identifier
 *   was written down, not that a particular sentence was.
 *
 * Nothing here reads git — no parent commit, no merge base, no `git status`. Those answer
 * differently on a shallow CI clone, on a clean tree and mid-rebase, so a gate built on one
 * runs in one place only. The inputs are three live SDK modules, the frozen lists below and
 * the changelog, so a local run and a CI run see the same thing or both fail.
 */
const ROOT = join(__dirname, '..', '..');
const CHANGELOG = 'CHANGELOG.md';

/** The level-3 heading this file's whole subject lives under. */
const SDK_HEADING = '### For add-on authors';

/**
 * The capability table as it stood on 2026-08-31, when this gate was written. **Frozen, and
 * not a file anybody maintains.**
 *
 * Same contract as the schema baseline next door: everything listed here predates the SDK
 * section's coverage and needs no entry, everything the table grows past it does, and an
 * entry once written stays written. So there is no chore at a release and nothing to bump.
 * The one route around the gate is to edit a line here instead of writing the entry, and
 * that is a deliberate, reviewable lie in a diff rather than a silence.
 *
 * A row's value is its permissions, sorted — `[]` where `PERMISSION_OF` says `null`, meaning
 * a hook every app is built out of, declared by nobody. Sorted rather than kept in source
 * order because the order in that table carries no meaning and a re-sort is not a change an
 * add-on can observe.
 */
const BASELINE_CAPABILITIES: Record<string, string[]> = {
  PhotoPickerModal: ['media'],
  ReportDialog: ['notifications', 'reports'],
  appStorageBytes: ['storage'],
  clearAppStorage: ['storage'],
  lifecycle: [],
  onAppForeground: [],
  onAppUnmount: [],
  useAccount: ['account'],
  useAccounts: ['social'],
  useAdmin: ['admin'],
  useAppAction: [],
  useAppEvents: ['app-events'],
  useAppLevels: [],
  useAppRegistry: ['app-registry'],
  useAppRegistryWrite: ['app-registry-write'],
  useBank: ['bank'],
  useCall: ['call'],
  useCamera: ['camera'],
  useClock: ['clock'],
  useClockWrite: ['clock-write'],
  useContacts: ['contacts'],
  useDeepLink: [],
  useDevTools: ['devtools'],
  useDisplay: ['display'],
  useDisplayWrite: ['display-write'],
  useHighscores: ['highscores'],
  useKeybinds: ['keybinds'],
  useKeybindsWrite: ['keybinds-write'],
  useLocation: ['location'],
  useLockScreen: ['lock-screen'],
  useLockScreenWrite: ['lock-screen-write'],
  useMail: ['mail'],
  useMarketplace: ['marketplace'],
  useMedia: ['media'],
  useMessages: ['messages'],
  useMusic: ['music'],
  useNavigation: ['navigation'],
  useNotificationSettings: ['notification-settings'],
  useNotificationSettingsWrite: ['notification-settings-write'],
  useNotifications: ['notifications'],
  usePersisted: ['storage'],
  usePhoneNotification: ['notifications'],
  useReport: ['reports'],
  useReports: ['admin'],
  useService: [],
  useSound: [],
  useStorage: ['storage'],
  useSystemHardware: ['system-hardware'],
  useSystemHardwareWrite: ['system-hardware-write'],
  useTheme: ['theme'],
  useThemeWrite: ['theme-write'],
  useTimer: [],
  useWallpaper: ['wallpaper'],
  useWallpaperWrite: ['wallpaper-write']
};

/**
 * `ALL_PERMISSIONS` as it stood on 2026-08-31, frozen on exactly the same terms.
 *
 * Kept separate from the table above rather than derived from it, because the two can
 * disagree and the disagreement is the interesting case: a permission that exists in the
 * vocabulary and discloses no hook is a name a manifest may declare and get nothing for,
 * and a hook whose permission is not in the vocabulary is a hook nobody can legally reach.
 * `permissions.test.ts` owns that cross-check; this list exists so that *growing* the
 * vocabulary is announced whether or not a hook came with it.
 */
const BASELINE_PERMISSIONS: string[] = [
  'account',
  'admin',
  'app-events',
  'app-registry',
  'app-registry-write',
  'bank',
  'call',
  'camera',
  'clock',
  'clock-write',
  'contacts',
  'devtools',
  'display',
  'display-write',
  'highscores',
  'keybinds',
  'keybinds-write',
  'location',
  'lock-screen',
  'lock-screen-write',
  'mail',
  'marketplace',
  'media',
  'messages',
  'music',
  'navigation',
  'notification-settings',
  'notification-settings-write',
  'notifications',
  'reports',
  'social',
  'storage',
  'system-hardware',
  'system-hardware-write',
  'theme',
  'theme-write',
  'wallpaper',
  'wallpaper-write'
];

// ---------------------------------------------------------------------------
// Reading the live capability table
// ---------------------------------------------------------------------------

/**
 * `PERMISSION_OF` reduced to the shape the baseline is frozen in.
 *
 * The declared type is `AppPermission | readonly AppPermission[] | null`, and all three
 * arms are live in that table — a kit component may disclose more than one permission, a
 * host hook discloses exactly one, and an implicit hook discloses none.
 */
const liveCapabilities = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [hook, value] of Object.entries(PERMISSION_OF)) {
    const list = value === null ? [] : Array.isArray(value) ? [...value] : [value as string];
    out[hook] = [...list].sort();
  }
  return out;
};

/** One difference between the live capability table and the frozen one. */
interface CapabilityChange {
  hook: string;
  kind: 'added' | 'removed' | 'regated';
  /** Every permission name that appeared or disappeared with this change. */
  permissions: string[];
}

/**
 * Every row the capability table has gained, lost, or re-gated.
 *
 * `regated` is the third case and the one worth naming separately: the hook is still there
 * and still exported, so nothing an export list watches has moved, but the manifest that
 * used to reach it no longer does. That is the shape of MICA-127 and of every future
 * split of a read hook from its write half.
 */
const capabilityDrift = (
  live: Record<string, string[]>,
  baseline: Record<string, string[]>
): CapabilityChange[] => {
  const changes: CapabilityChange[] = [];
  for (const hook of [...new Set([...Object.keys(live), ...Object.keys(baseline)])].sort()) {
    const now = live[hook];
    const then = baseline[hook];

    if (now !== undefined && then === undefined) {
      changes.push({ hook, kind: 'added', permissions: now });
      continue;
    }
    if (now === undefined && then !== undefined) {
      changes.push({ hook, kind: 'removed', permissions: then });
      continue;
    }
    if (now === undefined || then === undefined) continue;

    const moved = [
      ...now.filter((p) => !then.includes(p)),
      ...then.filter((p) => !now.includes(p))
    ].sort();
    if (moved.length > 0) changes.push({ hook, kind: 'regated', permissions: moved });
  }
  return changes;
};

/** Every member `ALL_PERMISSIONS` has gained or lost, as `name (added|removed)`. */
const permissionDrift = (live: readonly string[], baseline: readonly string[]): string[] =>
  [
    ...live.filter((p) => !baseline.includes(p)).map((p) => `${p} (added)`),
    ...baseline.filter((p) => !live.includes(p)).map((p) => `${p} (removed)`)
  ].sort();

// ---------------------------------------------------------------------------
// Reading the changelog
// ---------------------------------------------------------------------------

const changelogText = (): string => readFileSync(join(ROOT, CHANGELOG), 'utf8');

/**
 * The body of every `### For add-on authors` block in the document, run together.
 *
 * Scoped to the section rather than searched across the whole file, and that is the point
 * of the exercise. Before this gate, the two SDK breaks this repo has written down were
 * folded into owner-facing "Action required" prose, where somebody maintaining an add-on
 * had to read about phone numbers and Hodlr's spread to find them. A matcher satisfied by
 * a name appearing anywhere would leave the section empty forever and call that a pass.
 *
 * Every block counts, not just the newest: an entry stays announced once released, so a
 * hook named under a dated section three releases ago is still named.
 *
 * A line walk rather than one regex, because the terminator is "the next heading at this
 * level or above" and `[\s\S]*?` with a lookahead for that is the kind of expression
 * nobody re-reads correctly.
 */
const addOnSections = (changelog: string): string => {
  const out: string[] = [];
  let inside = false;
  for (const line of changelog.split('\n')) {
    if (line.trimEnd() === SDK_HEADING) {
      inside = true;
      continue;
    }
    if (inside && /^#{1,3} /.test(line)) inside = false;
    if (inside) out.push(line);
  }
  return out.join('\n');
};

/**
 * The text of every inline code span in a markdown document, run together.
 *
 * Same convention as `changelog.test.ts`: this file writes every identifier in backticks,
 * so reading code spans is what stops the word "media" in an unrelated sentence from
 * announcing the `media` permission.
 */
const codeSpans = (markdown: string): string =>
  [...markdown.matchAll(/`+([^`\n]+)`+/g)].map((m) => m[1]).join('   ');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is `name` written down as an identifier somewhere in those code spans?
 *
 * The boundary excludes `-` as well as letters, digits and `_`, which the schema gate's
 * version does not need to and this one does: permission names are hyphenated, and without
 * it `theme` would be announced by any entry that mentioned `theme-write`. Splitting a read
 * hook from a write half is the single most likely future change to this table, so the one
 * case the boundary has to get right is exactly that one.
 */
const isNamed = (name: string, spans: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`).test(spans);

/**
 * The capability changes an add-on author would not learn about by reading the section.
 *
 * A change is announced when the hook is named **and** every permission that moved with it
 * is named. Both halves are needed and they fail differently: naming only the hook leaves
 * the reader without the manifest line to add, and naming only the permission leaves them
 * without the call that needs it.
 *
 * Pure, so the probes below can drive it with input this repo does not have.
 */
const unannouncedCapabilities = (changes: CapabilityChange[], changelog: string): string[] => {
  const spans = codeSpans(addOnSections(changelog));
  return changes
    .filter(
      ({ hook, permissions }) =>
        !(isNamed(hook, spans) && permissions.every((p) => isNamed(p, spans)))
    )
    .map(({ hook, kind, permissions }) =>
      permissions.length > 0 ? `${hook} (${kind}: ${permissions.join(', ')})` : `${hook} (${kind})`
    );
};

/** The vocabulary members the section does not name. `p` arrives as `name (added)`. */
const unannouncedPermissions = (changes: string[], changelog: string): string[] => {
  const spans = codeSpans(addOnSections(changelog));
  return changes.filter((entry) => !isNamed(entry.split(' ')[0], spans));
};

describe('the SDK half of the changelog (MICA-125)', () => {
  // Every assertion below reads the file once through these, so a truncated or deleted
  // CHANGELOG.md is one failure rather than a quiet pass on every arm.
  describe('the gate can actually run', () => {
    it('reads a changelog with an add-on section in it', () => {
      expect(changelogText().length).toBeGreaterThan(500);
      expect(
        addOnSections(changelogText()).length,
        `no "${SDK_HEADING}" section found in ${CHANGELOG} — every assertion below would ` +
          `then be scanning an empty string and passing`
      ).toBeGreaterThan(200);
      expect(
        codeSpans(addOnSections(changelogText())).length,
        'the section has no code spans, so the matcher would report every identifier as ' +
          'missing rather than checking anything'
      ).toBeGreaterThan(20);
    });

    it('reads the live capability table', () => {
      const live = liveCapabilities();

      expect(
        Object.keys(live).length,
        'no capability rows found — the SDK imports failed and this file is checking nothing'
      ).toBeGreaterThanOrEqual(40);
      expect(ALL_PERMISSIONS.length).toBeGreaterThanOrEqual(30);
    });

    it('has baselines to compare against', () => {
      // Emptied or half-deleted, these would report every row as new — which fails loudly —
      // but a baseline swollen to match anything would report nothing and read as a pass.
      // AGENTS.md is explicit that a check which cannot run reads as a pass.
      expect(
        Object.keys(BASELINE_CAPABILITIES).length,
        'the frozen capability baseline is missing — restore it rather than letting the ' +
          'gate go quiet'
      ).toBeGreaterThanOrEqual(40);
      expect(BASELINE_PERMISSIONS.length).toBeGreaterThanOrEqual(30);
    });
  });

  describe('arm 1: the pinned contract version', () => {
    it('is written down where an add-on author reads it', () => {
      const spans = codeSpans(addOnSections(changelogText()));

      expect(
        isNamed(`v${SDK_CONTRACT_VERSION}`, spans),
        `the SDK publishes contract v${SDK_CONTRACT_VERSION} and no "${SDK_HEADING}" ` +
          `section names it. Bumping \`SDK_CONTRACT_VERSION\` means a published add-on has ` +
          `stopped compiling against something — write \`v${SDK_CONTRACT_VERSION}\` in that ` +
          `section, in backticks, and say what broke.`
      ).toBe(true);
    });
  });

  describe('arm 2: the capability table', () => {
    it('announces every hook the SDK gained, lost or re-gated', () => {
      const missing = unannouncedCapabilities(
        capabilityDrift(liveCapabilities(), BASELINE_CAPABILITIES),
        changelogText()
      );

      expect(
        missing,
        `a hook added, removed or moved behind a different permission is work for somebody ` +
          `maintaining an add-on outside this repo — name the hook and every permission ` +
          `that moved with it, in backticks, under "${SDK_HEADING}" in ${CHANGELOG}`
      ).toEqual([]);
    });

    it('announces every permission the vocabulary gained or lost', () => {
      const missing = unannouncedPermissions(
        permissionDrift(ALL_PERMISSIONS, BASELINE_PERMISSIONS),
        changelogText()
      );

      expect(
        missing,
        `a manifest declaring a permission that is no longer in \`ALL_PERMISSIONS\` keeps ` +
          `loading with the declaration silently ignored — name the permission in ` +
          `backticks under "${SDK_HEADING}" in ${CHANGELOG}`
      ).toEqual([]);
    });
  });

  // The live tables match their baselines, so both arms above pass over an empty set of
  // changes. These drive the same matchers with input of every kind, so "nothing to
  // announce" is a verified silence rather than a scan that quietly matches nothing.
  describe('the check fires, rather than merely being configured', () => {
    const section = (body: string): string =>
      `# Changelog\n\n## Unreleased\n\n${SDK_HEADING}\n\n${body}\n\n### Fixed\n\n- Something else.\n`;

    it('reads only the add-on section, not the whole file', () => {
      const elsewhere =
        `# Changelog\n\n## Unreleased\n\n### Action required\n\n- \`useWidgets\` changed.\n\n` +
        `${SDK_HEADING}\n\n- Nothing.\n`;

      expect(addOnSections(elsewhere).trim()).toBe('- Nothing.');
    });

    it('runs several sections together, so an older release still counts', () => {
      const older = ['', '## 2026-08-31', '', SDK_HEADING, '', '- `useGadgets`.', ''].join('\n');
      const two = section('- `useWidgets`.') + older;

      expect(codeSpans(addOnSections(two))).toContain('useWidgets');
      expect(codeSpans(addOnSections(two))).toContain('useGadgets');
    });

    it('sees a hook the table gained', () => {
      expect(capabilityDrift({ useWidgets: ['widgets'] }, {})).toEqual([
        { hook: 'useWidgets', kind: 'added', permissions: ['widgets'] }
      ]);
    });

    it('sees a hook the table lost', () => {
      expect(capabilityDrift({}, { useWidgets: ['widgets'] })).toEqual([
        { hook: 'useWidgets', kind: 'removed', permissions: ['widgets'] }
      ]);
    });

    it('replays MICA-127: a hook moved behind a different permission', () => {
      // The break no export list and no prop list could see. `useTheme` kept its name and
      // kept being exported; what changed was which manifest line reaches it.
      expect(capabilityDrift({ useTheme: ['theme-write'] }, { useTheme: ['theme'] })).toEqual([
        { hook: 'useTheme', kind: 'regated', permissions: ['theme', 'theme-write'] }
      ]);
    });

    it('reports a hook the section does not name', () => {
      const change: CapabilityChange = {
        hook: 'useWidgets',
        kind: 'added',
        permissions: ['widgets']
      };

      expect(unannouncedCapabilities([change], section('- Nothing to report.'))).toEqual([
        'useWidgets (added: widgets)'
      ]);
    });

    it('accepts one written down as prose plus identifiers', () => {
      const change: CapabilityChange = {
        hook: 'useWidgets',
        kind: 'added',
        permissions: ['widgets']
      };
      const body = '- `useWidgets` is new; declare `widgets` in your manifest to reach it.';

      expect(unannouncedCapabilities([change], section(body))).toEqual([]);
    });

    it('is not satisfied by naming the hook and not the permission', () => {
      // The failure this prevents: an entry that tells an author what to call and leaves
      // them to discover the manifest line by being refused at runtime.
      const change: CapabilityChange = {
        hook: 'useWidgets',
        kind: 'added',
        permissions: ['widgets']
      };

      expect(unannouncedCapabilities([change], section('- `useWidgets` is new.'))).toEqual([
        'useWidgets (added: widgets)'
      ]);
    });

    it('is not satisfied by the words appearing outside a code span', () => {
      const change: CapabilityChange = {
        hook: 'useWidgets',
        kind: 'added',
        permissions: ['widgets']
      };
      const body = 'The phone now draws widgets, and useWidgets reads them.';

      expect(unannouncedCapabilities([change], section(body))).toEqual([
        'useWidgets (added: widgets)'
      ]);
    });

    it('is not satisfied by an entry that names the hook somewhere else in the file', () => {
      const elsewhere =
        `# Changelog\n\n## Unreleased\n\n### Action required\n\n` +
        '- `useWidgets` now needs `widgets`.\n\n' +
        `${SDK_HEADING}\n\n- Nothing this release.\n`;
      const change: CapabilityChange = {
        hook: 'useWidgets',
        kind: 'added',
        permissions: ['widgets']
      };

      expect(unannouncedCapabilities([change], elsewhere)).toEqual(['useWidgets (added: widgets)']);
    });

    it('does not let a write half announce the read half it split from', () => {
      // `theme` must be named on its own. Without the `-` in the matcher's boundary,
      // `theme-write` would satisfy it and the half that actually lost its setters would
      // go unmentioned.
      const spans = codeSpans(addOnSections(section('- `useThemeWrite` needs `theme-write`.')));

      expect(isNamed('theme-write', spans)).toBe(true);
      expect(isNamed('theme', spans)).toBe(false);
    });

    it('sees a member added to the vocabulary, and one dropped', () => {
      expect(permissionDrift(['a', 'b'], ['a'])).toEqual(['b (added)']);
      expect(permissionDrift(['a'], ['a', 'b'])).toEqual(['b (removed)']);
    });

    it('reports a vocabulary member the section does not name', () => {
      expect(unannouncedPermissions(['widgets (added)'], section('- Nothing.'))).toEqual([
        'widgets (added)'
      ]);
      expect(unannouncedPermissions(['widgets (added)'], section('- `widgets` is new.'))).toEqual(
        []
      );
    });

    it('reads the real tables, so the arms above are not asserted against a literal', () => {
      // If `PERMISSION_OF` or `ALL_PERMISSIONS` stopped resolving, `liveCapabilities()` would
      // be empty and `capabilityDrift` would report every baseline row as removed — loud. The
      // dangerous direction is a table that resolves to something plausible and wrong, so
      // pin one row of each of the two shapes it holds, plus a member of the vocabulary.
      const live = liveCapabilities();

      expect(live.useTheme).toEqual(['theme']);
      expect(live.useAppLevels).toEqual([]);
      expect(ALL_PERMISSIONS).toContain('theme-write');
    });
  });

  describe('the section stays where a reader will find it', () => {
    it('exists under Unreleased, so there is somewhere to write the next entry', () => {
      // Without it the entry is written after the tag or not at all. An empty one saying
      // "nothing changed" is the same checked silence `### Action required` / "None." is.
      const unreleased = changelogText().split(/^## /m)[1] ?? '';

      expect(
        unreleased.includes(SDK_HEADING),
        `add a "${SDK_HEADING}" section under "## Unreleased" in ${CHANGELOG}, even if the ` +
          `answer this release is that nothing on the SDK surface moved`
      ).toBe(true);
    });
  });
});
