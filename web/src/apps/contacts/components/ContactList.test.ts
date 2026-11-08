// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: in-process facets — a unit test stands in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
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

describe('ContactList windowing (MICA-446)', () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    contact({ id: i + 1, firstname: `Person${i + 1}`, phone: `555-${1000 + i}` })
  );

  it('renders only the rows near the viewport, not the whole list', () => {
    const { queryByText, container } = renderList(many);
    expect(queryByText('Person1')).toBeTruthy();
    expect(queryByText('Person100')).toBeNull();
    expect(container.querySelectorAll('[role="button"]').length).toBeLessThan(many.length / 2);
  });

  it('holds the whole list in its spacers, so the scroll height is the full list', () => {
    const { container } = renderList(many);
    const rows = container.querySelectorAll('[data-contact-rows] > *').length;
    const group = container.querySelector('[data-contact-rows]')!;
    const below = group.nextElementSibling as HTMLElement;
    // jsdom lays nothing out, so the fallback pitch stands: 73px a row.
    expect(below.style.height).toBe(`${(many.length - rows) * 73}px`);
  });

  it('renders the end of the list once it is scrolled there', async () => {
    const { container, queryByText } = renderList(many);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    scroller.scrollTop = many.length * 73;
    await fireEvent.scroll(scroller);
    expect(queryByText('Person100')).toBeTruthy();
    expect(queryByText('Person1')).toBeNull();
  });
});
