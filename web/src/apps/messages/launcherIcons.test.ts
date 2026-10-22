// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-420: a launcher glyph's fallback size is the `size-icon-xl` token (2rem), not a raw
 * `h-8 w-8` — for the communication apps, as `blabber/panels.test.ts` pins Blabber's. Admin's
 * is 1.75rem, which no token matches, so it is not here.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import type { Component } from 'svelte';
import Phone from '../phone/Icon.svelte';
import Jobs from '../jobs/Icon.svelte';
import Messages from './Icon.svelte';
import Contacts from '../contacts/Icon.svelte';
import Mail from '../mail/Icon.svelte';
import Places from '../places/Icon.svelte';

const ICONS: [string, Component][] = [
  ['phone', Phone],
  ['jobs', Jobs],
  ['messages', Messages],
  ['contacts', Contacts],
  ['mail', Mail],
  ['places', Places]
];

describe('launcher icons (MICA-420)', () => {
  it.each(ICONS)('%s draws at the xl icon token when the shell passes no class', (_id, Icon) => {
    const { container } = render(Icon);
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('size-icon-xl');
  });
});
