import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contacts, favoriteContacts } from './contacts';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../utils/fetchNui';

describe('contacts store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads contacts list using fetchNui', async () => {
    const mockContacts = [
      { id: 1, name: 'Alice', number: '555-0100', favorite: true },
      { id: 2, name: 'Bob', number: '555-0200', favorite: false }
    ];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockContacts as any);

    await contacts.load();
    expect(get(contacts)).toEqual(mockContacts);
  });

  it('filters favorite contacts via derived store', async () => {
    const mockContacts = [
      { id: 1, name: 'Alice', number: '555-0100', favorite: true },
      { id: 2, name: 'Bob', number: '555-0200', favorite: false }
    ];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockContacts as any);

    await contacts.load();
    expect(get(favoriteContacts)).toEqual([mockContacts[0]]);
  });

  it('adds a new contact to store', async () => {
    const newContactData = { firstname: 'Charlie', phone: '555-0300' };
    const createdContact = { id: 3, ...newContactData, favorite: false };

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(createdContact as any);

    const result = await contacts.add(newContactData as any);
    expect(result).toEqual(createdContact);
    expect(get(contacts)).toContainEqual(createdContact);
  });

  it('rejects adding contact when mandatory firstname or phone is missing', async () => {
    await expect(contacts.add({ firstname: '', phone: '555-0100' } as any)).rejects.toThrow(
      'First name and phone number are required.'
    );
    await expect(contacts.add({ firstname: 'John', phone: '   ' } as any)).rejects.toThrow(
      'First name and phone number are required.'
    );
  });

  it('rejects sharing contact when mandatory firstname or phone is missing', async () => {
    await expect(contacts.share({ firstname: '', phone: '555-0100' } as any)).rejects.toThrow(
      'First name and phone number are required to share contact.'
    );
    await expect(contacts.share({ firstname: 'John', phone: '' } as any)).rejects.toThrow(
      'First name and phone number are required to share contact.'
    );
  });

  it('deletes a contact from store by id', async () => {
    const initialContacts = [
      { id: 1, name: 'Alice', number: '555-0100' },
      { id: 2, name: 'Bob', number: '555-0200' }
    ];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(initialContacts as any);
    await contacts.load();

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ ok: true } as any);
    await contacts.delete(1);

    expect(get(contacts)).toEqual([{ id: 2, name: 'Bob', number: '555-0200' }]);
  });
});
