// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedStrings } from './phone/hardcodedStrings';

/**
 * The localization ratchet (MICA-61).
 *
 * Every user-facing string used to be an English literal in a `.svelte` file. The
 * mechanism now exists — `registerMessages` and `$t` — and the extraction is spread over
 * MICA-214 and MICA-215, so this file freezes the count of literals per file and lets
 * each number go **down only**. A file at zero is done; a file not listed must stay at zero,
 * which is what stops a new app, or a new string in a finished one, from decaying back to
 * English. When every entry is gone, the table goes with it and the rule is simply "none".
 *
 * `findHardcodedStrings` is a scanner and says what it covers; a literal it cannot see is
 * not gated here, so a green run is a floor, not proof of translation.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = ['web/src/apps', 'web/src/shell', 'sdk/ui'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.svelte') && !full.includes('__fixtures__')) out.push(full);
  }
  return out;
}

const counts = (): Map<string, { count: number; sample: string[] }> => {
  const result = new Map<string, { count: number; sample: string[] }>();
  for (const root of SCANNED) {
    for (const file of walk(path.join(ROOT, root))) {
      const found = findHardcodedStrings(fs.readFileSync(file, 'utf8'));
      if (found.length === 0) continue;
      result.set(path.relative(ROOT, file), {
        count: found.length,
        sample: found.slice(0, 5).map((f) => `${f.line}: ${f.text}`)
      });
    }
  }
  return result;
};

/** Frozen on 2026-09-01 when the mechanism landed. Lower a number; never raise one. */
const BASELINE: Record<string, number> = {
  'web/src/apps/contacts/components/ContactDetails.svelte': 17,
  'web/src/apps/contacts/components/ContactForm.svelte': 9,
  'web/src/apps/contacts/components/ContactList.svelte': 2,
  'web/src/apps/contacts/index.svelte': 16,
  'web/src/apps/hodlr/components/Portfolio.svelte': 12,
  'web/src/apps/hodlr/components/Trade.svelte': 6,
  'web/src/apps/hodlr/index.svelte': 1,
  'web/src/apps/mail/index.svelte': 4,
  'web/src/apps/marketplace/components/CreateListing.svelte': 7,
  'web/src/apps/marketplace/components/Feed.svelte': 5,
  'web/src/apps/marketplace/components/ListingDetail.svelte': 3,
  'web/src/apps/marketplace/components/MyListings.svelte': 8,
  'web/src/apps/marketplace/index.svelte': 1,
  'web/src/apps/media/components/PhotoDetail.svelte': 8,
  'web/src/apps/media/components/PhotoGrid.svelte': 2,
  'web/src/apps/media/index.svelte': 14,
  'web/src/apps/messages/components/ConversationDetailsModal.svelte': 8,
  'web/src/apps/messages/components/ConversationList.svelte': 3,
  'web/src/apps/messages/components/MessageBubble.svelte': 15,
  'web/src/apps/messages/components/MessageComposer.svelte': 14,
  'web/src/apps/messages/components/MessageThread.svelte': 3,
  'web/src/apps/messages/index.svelte': 19,
  'web/src/apps/phone/index.svelte': 14,
  'web/src/apps/settings/components/ColorWheelPicker.svelte': 2,
  'web/src/apps/settings/components/ThemeAndWallpaper.svelte': 18,
  'web/src/apps/settings/index.svelte': 25,
  'web/src/apps/settings/panes/About.svelte': 11,
  'web/src/apps/settings/panes/AppInfo.svelte': 24,
  'web/src/apps/settings/panes/DeveloperTools.svelte': 24,
  'web/src/apps/settings/panes/Display.svelte': 25,
  'web/src/apps/settings/panes/License.svelte': 5,
  'web/src/apps/settings/panes/LockScreen.svelte': 12,
  'web/src/apps/settings/panes/Network.svelte': 8,
  'web/src/apps/settings/panes/Notifications.svelte': 18,
  'web/src/apps/settings/panes/Privacy.svelte': 1,
  'web/src/apps/settings/panes/Shortcuts.svelte': 4,
  'web/src/apps/settings/panes/Sound.svelte': 16
};

describe('hardcoded user-facing strings (MICA-61)', () => {
  const live = counts();

  it('scans a plausible amount of source', () => {
    expect(live.size).toBeGreaterThan(20);
  });

  it('no file has more hardcoded strings than its frozen count', () => {
    const over: string[] = [];
    for (const [file, { count, sample }] of live) {
      const allowed = BASELINE[file] ?? 0;
      if (count > allowed) {
        over.push(`${file}: ${count} (allowed ${allowed})\n    ${sample.join('\n    ')}`);
      }
    }
    expect(
      over,
      'a user-facing string is hardcoded English — read it through $t and a registered catalog (MICA-61)'
    ).toEqual([]);
  });

  it('the frozen counts are honest: a file that got better lowers its entry', () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const count = live.get(file)?.count ?? 0;
      if (count < allowed) stale.push(`${file}: now ${count}, baseline says ${allowed}`);
    }
    expect(stale, 'lower the baseline to the new count so the ratchet cannot slip back').toEqual(
      []
    );
  });
});
