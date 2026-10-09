// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * In-process facets, as `MediaThumb.test.ts` sets them up: the tiles draw through
 * `MediaThumb`, which reads streamer mode through a host hook.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import type { MediaItem, MediaPreview } from '@mica/shared/types';

const picker = vi.hoisted(() => ({
  full: null as Partial<MediaItem> | null,
  toast: { show: vi.fn() }
}));

vi.mock('../host/useMedia', async () => {
  const { writable: store } = await import('svelte/store');
  return {
    useMedia: () => ({
      media: store<MediaPreview[]>([{ id: 7, kind: 'photo' }]),
      fullMedia: async () => picker.full
    })
  };
});
vi.mock('../host/usePhoneNotification', () => ({
  usePhoneNotification: () => ({ toast: picker.toast })
}));

import PhotoPickerModal from './PhotoPickerModal.svelte';

/**
 * MICA-339. Single-select hands a photo's `data` to the caller as an image, and the contact
 * avatar is drawn from it on every phone that shows the contact. A remote URL there, in a row
 * stored before the server checked `data`, was the beacon F9 closes; only inline bytes are
 * handed over now, the rule `MediaThumb` draws `data` by.
 */
describe('PhotoPickerModal single-select', () => {
  beforeEach(() => {
    picker.toast = { show: vi.fn() };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const pickTheOnlyPhoto = async (data: string) => {
    picker.full = { id: 7, kind: 'photo', data };
    const onselect = vi.fn();
    const { container } = render(PhotoPickerModal, { onselect, onclose: () => {} });
    const tile = container.querySelector('.grid button') as HTMLButtonElement;
    await fireEvent.click(tile);
    return onselect;
  };

  it('hands over an inline photo', async () => {
    const onselect = await pickTheOnlyPhoto('data:image/webp;base64,UklGRg==');
    await waitFor(() => expect(onselect).toHaveBeenCalledWith('data:image/webp;base64,UklGRg=='));
  });

  it.each([
    'https://logger.attacker.example/p.png',
    '//logger.attacker.example/p.png',
    'http://logger.attacker.example/p.png'
  ])('refuses %s, and says so', async (data) => {
    const onselect = await pickTheOnlyPhoto(data);
    await waitFor(() => expect(picker.toast.show).toHaveBeenCalled());
    expect(onselect).not.toHaveBeenCalled();
  });
});
