import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contacts, favoriteContacts } from './contacts';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

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

  describe('a failed write is visible to the caller', () => {
    /**
     * These stores used to wrap every call in a `try/catch` that could never fire,
     * because `fetchNui` swallowed everything and returned `null`. `add` therefore
     * returned `undefined` on failure and the UI announced "Contact added successfully"
     * for a contact that was never created.
     */
    const seed = [{ id: 1, firstname: 'Alice', phone: '555-0100' }];

    beforeEach(async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(seed as any);
      await contacts.load();
      vi.restoreAllMocks();
    });

    it('add rejects and leaves the list alone', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('Player not authenticated'));

      await expect(contacts.add({ firstname: 'Bob', phone: '555-0200' } as any)).rejects.toThrow(
        'Player not authenticated'
      );
      expect(get(contacts)).toEqual(seed);
    });

    it('never inserts an error envelope as if it were a contact', async () => {
      // The precise old failure: `{ error }` is truthy, so it was pushed into the list.
      vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('nope'));

      await contacts.add({ firstname: 'Bob', phone: '555-0200' } as any).catch(() => {});
      for (const c of get(contacts)) {
        expect(c).not.toHaveProperty('error');
      }
    });

    it('update rejects and does not apply the change locally', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('denied'));

      await expect(
        contacts.update({ id: 1, firstname: 'Renamed', phone: '555-0100' } as any)
      ).rejects.toThrow('denied');
      expect(get(contacts)[0].firstname).toBe('Alice');
    });

    it('delete rejects and keeps the row', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('denied'));

      await expect(contacts.delete(1)).rejects.toThrow('denied');
      expect(get(contacts)).toHaveLength(1);
    });
  });
});
