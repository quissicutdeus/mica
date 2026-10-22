// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: in-process facets — a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import type { Contact } from '@mica/shared/types';
import ShareLiveSheet from './ShareLiveSheet.svelte';
import en from './locales/en.json';
import de from './locales/de.json';

registerMessages('places', { en, de });

describe('ShareLiveSheet avatar (MICA-417)', () => {
  it('a photo beside the name stays silent rather than read the name twice', () => {
    const contacts = [
      {
        id: 1,
        citizenid: 'CID',
        firstname: 'Ada',
        lastname: 'King',
        phone: '555-0101',
        avatar: 'data:image/png;base64,iVBORw0KGgo='
      } as Contact
    ];
    const { container, getByText } = render(ShareLiveSheet, {
      props: { contacts, durations: [15], busy: false, onstart: () => {}, oncancel: () => {} }
    });
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(getByText('Ada King')).toBeTruthy();
  });
});
