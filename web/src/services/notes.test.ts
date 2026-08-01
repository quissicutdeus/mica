import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notes } from './notes';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

describe('notes store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads notes list from fetchNui', async () => {
    const mockNotes = [
      { id: 1, title: 'Meeting Notes', content: 'Discuss project architecture', citizenid: 'CIT_1' }
    ];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockNotes as any);

    await notes.load();
    expect(get(notes)).toEqual(mockNotes);
  });

  it('adds a note', async () => {
    const newNoteData = { title: 'Shopping List', content: 'Buy milk and eggs' };
    const createdNote = { id: 2, ...newNoteData, citizenid: 'CIT_1' };

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(createdNote as any);

    const result = await notes.add(newNoteData as any);
    expect(result).toEqual(createdNote);
    expect(get(notes)).toContainEqual(createdNote);
  });

  it('updates a note', async () => {
    const initialNotes = [{ id: 1, title: 'Old Title', content: 'Content', citizenid: 'CIT_1' }];
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(initialNotes as any);
    await notes.load();

    const updatedNote = { id: 1, title: 'New Title', content: 'Content', citizenid: 'CIT_1' };
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);

    await notes.update(updatedNote as any);
    expect(get(notes)).toEqual([updatedNote]);
  });

  it('deletes a note by id', async () => {
    const initialNotes = [
      { id: 1, title: 'Note 1', content: 'C1', citizenid: 'CIT_1' },
      { id: 2, title: 'Note 2', content: 'C2', citizenid: 'CIT_1' }
    ];
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(initialNotes as any);
    await notes.load();

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);
    await notes.delete(1);

    expect(get(notes)).toEqual([{ id: 2, title: 'Note 2', content: 'C2', citizenid: 'CIT_1' }]);
  });
});
