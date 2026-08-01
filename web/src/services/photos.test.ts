import { describe, it, expect, vi, beforeEach } from 'vitest';
import { photos } from './photos';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

describe('photos store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads photo gallery', async () => {
    const mockPhotos = [{ id: 1, image: 'data:image/png;base64,123', citizenid: 'CIT_1' }];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockPhotos as any);

    await photos.load();
    expect(get(photos)).toEqual(mockPhotos);
  });

  it('adds photo to gallery', async () => {
    const newPhoto = { id: 2, image: 'data:image/png;base64,456', citizenid: 'CIT_1' };
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(newPhoto as any);

    const result = await photos.add({ image: 'data:image/png;base64,456' });
    expect(result).toEqual(newPhoto);
    expect(get(photos)).toContainEqual(newPhoto);
  });

  it('deletes photo by id', async () => {
    const mockPhotos = [
      { id: 1, image: 'img1', citizenid: 'CIT_1' },
      { id: 2, image: 'img2', citizenid: 'CIT_1' }
    ];
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockPhotos as any);
    await photos.load();

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);
    await photos.delete(1);

    expect(get(photos)).toEqual([{ id: 2, image: 'img2', citizenid: 'CIT_1' }]);
  });
});
