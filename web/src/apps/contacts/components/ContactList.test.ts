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
import { registerMessages } from '@mica/sdk';
import type { Contact } from '@mica/shared/types';
import ContactList from './ContactList.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('contacts', { en, de });

const PHOTO = 'data:image/png;base64,iVBORw0KGgo=';

const contact = (over: Partial<Contact>): Contact =>
  ({ id: 1, citizenid: 'CID', firstname: 'Ada', phone: '555-0101', ...over }) as Contact;

const renderList = (others: Contact[]) =>
  render(ContactList, {
    props: {
      favorites: [],
      others,
      total: others.length,
      loaded: true,
      query: '',
      onselect: () => {}
    }
  });

describe('ContactList avatar (MICA-417)', () => {
  it('a photo beside the name stays silent rather than read the name twice', () => {
    const { container, getByText } = renderList([contact({ lastname: 'King', avatar: PHOTO })]);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(getByText('Ada King')).toBeTruthy();
  });

  it('copes with a contact that has no last name', () => {
    const { container, getByText } = renderList([contact({ avatar: PHOTO })]);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(getByText('Ada')).toBeTruthy();
  });
});
