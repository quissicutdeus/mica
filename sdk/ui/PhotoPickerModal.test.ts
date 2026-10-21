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
  toast: { show: vi.fn() },
  phoneNotification: null as null | (() => unknown),
  remoteCall: vi.fn(async (..._args: unknown[]): Promise<unknown> => 'toast-1')
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
  usePhoneNotification: () => picker.phoneNotification?.() ?? { toast: picker.toast }
}));
// The wire under the iframe twin, for the frame case: a call is a spy, a store its seed.
vi.mock('../host/iframe/remote', async (importOriginal) => {
  const { readable } = await import('svelte/store');
  return {
    ...(await importOriginal<typeof import('../host/iframe/remote')>()),
    remoteCall: picker.remoteCall,
    remoteStore: (_facet: string, _args: unknown, _member: string, initial: unknown) =>
      readable(initial)
  };
});

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
    picker.phoneNotification = null;
    picker.remoteCall.mockClear();
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

  /**
   * MICA-254. An add-on frame's `toast` is a read-only twin with no `show`, deliberately, so a
   * refused photo used to throw inside the `catch` meant to report it. It says so through
   * `sendNotification` instead, which names no app.
   */
  it("says so from an add-on's frame too, with no app named", async () => {
    const twin = await import('../host/iframe/facets/phoneNotification');
    picker.phoneNotification = twin.phoneNotification;
    const onselect = await pickTheOnlyPhoto('https://logger.attacker.example/p.png');
    await waitFor(() =>
      expect(picker.remoteCall).toHaveBeenCalledWith('phoneNotification', [], 'sendNotification', {
        type: 'error',
        message: 'That photo could not be loaded. Try another.'
      })
    );
    expect(onselect).not.toHaveBeenCalled();
  });
});

/**
 * MICA-406. The picker opens over a screen whose own title is an `h1`, so its heading is an
 * `h2`: an `h3` there is the jump axe reports as `heading-order`. The dialog keeps its name
 * from `aria-label`, the way every sdk/ui dialog is named.
 */
describe('PhotoPickerModal heading', () => {
  it('is a level-2 heading inside a dialog named by the same words', () => {
    const { getByRole, container } = render(PhotoPickerModal, { onclose: () => {} });
    const dialog = getByRole('dialog', { name: 'Select Photo' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(getByRole('heading', { level: 2, name: 'Select Photo' })).toBeTruthy();
    expect(container.querySelector('h3')).toBeNull();
  });

  it("follows a caller's own title in both", () => {
    const { getByRole } = render(PhotoPickerModal, { title: 'Add photos', onclose: () => {} });
    expect(getByRole('dialog', { name: 'Add photos' })).toBeTruthy();
    expect(getByRole('heading', { level: 2, name: 'Add photos' })).toBeTruthy();
  });
});
