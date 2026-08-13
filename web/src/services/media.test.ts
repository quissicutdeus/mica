import { describe, it, expect, vi, beforeEach } from 'vitest';
import { media } from './media';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

describe('media store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads media gallery', async () => {
    const mockMedia = [{ id: 1, image: 'data:image/png;base64,123', citizenid: 'CIT_1' }];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockMedia as any);

    await media.load();
    expect(get(media)).toEqual(mockMedia);
  });

  it('adds photo to gallery', async () => {
    const newPhoto = { id: 2, image: 'data:image/png;base64,456', citizenid: 'CIT_1' };
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(newPhoto as any);

    const result = await media.add({ kind: 'photo' as const, data: 'data:image/png;base64,456' });
    expect(result).toEqual(newPhoto);
    expect(get(media)).toContainEqual(newPhoto);
  });

  it('deletes photo by id', async () => {
    const mockMedia = [
      { id: 1, image: 'img1', citizenid: 'CIT_1' },
      { id: 2, image: 'img2', citizenid: 'CIT_1' }
    ];
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockMedia as any);
    await media.load();

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);
    await media.delete(1);

    expect(get(media)).toEqual([{ id: 2, image: 'img2', citizenid: 'CIT_1' }]);
  });
});
