// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: in-process facets — a unit test stands in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import { registerMessages, type Contact } from '@mica/sdk';
import ContactDetails from './ContactDetails.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('contacts', { en, de });

const noop = () => {};

describe('ContactDetails avatar (MICA-417)', () => {
  it('the header photo stays silent: the name is printed under it', () => {
    const contact = {
      id: 1,
      citizenid: 'CID',
      firstname: 'Ada',
      lastname: 'King',
      phone: '555-0101',
      avatar: 'data:image/png;base64,iVBORw0KGgo='
    } as Contact;
    const { container, getByRole } = render(ContactDetails, {
      props: {
        contact,
        isEditing: false,
        busy: false,
        recentMessages: [],
        messageCount: 0,
        oncall: noop,
        onmessage: noop,
        onshare: noop,
        ondelete: noop,
        onsave: noop,
        ontogglefavorite: noop,
        onpickphoto: noop,
        onedit: noop
      }
    });
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(getByRole('heading', { level: 2, name: 'Ada King' })).toBeTruthy();
  });
});

describe('ContactDetails empty-thread glyph (MICA-420)', () => {
  it('draws the no-messages glyph at the xl icon token', () => {
    const { container } = render(ContactDetails, {
      props: {
        contact: { id: 1, citizenid: 'CID', firstname: 'Ada', phone: '555-0101' } as Contact,
        isEditing: false,
        busy: false,
        recentMessages: [],
        messageCount: 0,
        oncall: noop,
        onmessage: noop,
        onshare: noop,
        ondelete: noop,
        onsave: noop,
        ontogglefavorite: noop,
        onpickphoto: noop,
        onedit: noop
      }
    });
    const icon = container.querySelector('svg.text-outline');
    expect(icon?.classList.contains('size-icon-xl')).toBe(true);
    expect(icon?.classList.contains('h-8')).toBe(false);
  });
});
