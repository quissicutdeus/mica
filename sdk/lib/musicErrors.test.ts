// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { locale } from '../i18n';
import { describeMusicError, reasonForCode } from './musicErrors';

/**
 * The one line under a music failure reads from the `ui` catalog (MICA-217).
 *
 * It was composed in this module in English, which the `.svelte` scanner could not see
 * and no locale could reach. The phrase is the same; where it comes from is what changed.
 */
describe('describeMusicError', () => {
  afterEach(() => locale.set('en'));

  it('maps the IFrame API codes the player actually distinguishes', () => {
    expect(reasonForCode(101)).toBe('embed-blocked');
    expect(reasonForCode(150)).toBe('embed-blocked');
    expect(reasonForCode(100)).toBe('unavailable');
    expect(reasonForCode(2)).toBe('unplayable');
    expect(reasonForCode(9999)).toBe('unplayable');
  });

  it('reads each reason from the ui catalog rather than composing English', () => {
    expect(describeMusicError('embed-blocked')).toBe("Can't be played outside YouTube");
    expect(describeMusicError('unavailable')).toBe('Unavailable — removed or private');
    expect(describeMusicError('unplayable')).toBe("Can't be played");
  });

  it('follows the active locale', () => {
    locale.set('de');
    expect(describeMusicError('unavailable')).toBe('Nicht verfügbar — entfernt oder privat');
  });

  it('uses the translator it is handed, so a rendered row can pass its own $t', () => {
    const translate = (key: string) => `<${key}>`;
    expect(describeMusicError('embed-blocked', translate)).toBe('<ui.musicEmbedBlocked>');
  });
});
