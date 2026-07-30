import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { isTakingPhoto, isPreviewingPhoto } from './camera';

describe('camera store', () => {
  it('initializes photo states to false', () => {
    expect(get(isTakingPhoto)).toBe(false);
    expect(get(isPreviewingPhoto)).toBe(false);
  });

  it('updates isTakingPhoto state', () => {
    isTakingPhoto.set(true);
    expect(get(isTakingPhoto)).toBe(true);
    isTakingPhoto.set(false);
    expect(get(isTakingPhoto)).toBe(false);
  });

  it('updates isPreviewingPhoto state', () => {
    isPreviewingPhoto.set(true);
    expect(get(isPreviewingPhoto)).toBe(true);
    isPreviewingPhoto.set(false);
    expect(get(isPreviewingPhoto)).toBe(false);
  });
});
