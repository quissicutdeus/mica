// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * Owner sounds in Settings > Sound (MICA-256): the ringtone list is the five built-ins
 * followed by the owner's files, and the notification tone is a second list of its own.
 * In-process facets, standing in for the shell (MICA-172).
 */
import '../../../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { registerMessages } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';
import Sound from './Sound.svelte';
import {
  audio,
  ringtone,
  setRingtone,
  notificationTone,
  setNotificationTone,
  RINGTONE_OPTIONS
} from '../../../shell/state/audio';
import { ownerConfig, DEFAULT_OWNER_CONFIG } from '../../../shell/state/ownerConfig';

registerMessages('settings', { en, de });

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    finished: Promise.resolve(),
    cancel: vi.fn(),
    finish: vi.fn()
  });
}

describe('Sound pane owner sounds', () => {
  beforeEach(() => {
    setRingtone('classic');
    setNotificationTone('default');
    ownerConfig.set({
      ...DEFAULT_OWNER_CONFIG,
      sounds: [{ id: 'owner:Sample-Tone', label: 'Sample Tone', url: '/x/Sample-Tone.wav' }]
    });
  });

  afterEach(() => {
    ownerConfig.set(DEFAULT_OWNER_CONFIG);
    vi.restoreAllMocks();
  });

  it('lists owner sounds after the built-in ringtones and in the notification list', () => {
    const { getAllByTestId } = render(Sound);
    const rings = getAllByTestId('ringtone-option').map((el) => el.textContent?.trim());
    expect(rings).toEqual([...RINGTONE_OPTIONS.map((o) => o.label), 'Sample Tone']);
    const tones = getAllByTestId('notification-tone-option').map((el) => el.textContent?.trim());
    expect(tones).toEqual(['Default', 'Sample Tone']);
  });

  it('choosing an owner ringtone persists it and previews it, leaving the notification tone alone', async () => {
    const preview = vi.spyOn(audio, 'preview').mockImplementation(() => {});
    const { getAllByTestId } = render(Sound);
    await fireEvent.click(getAllByTestId('ringtone-option')[RINGTONE_OPTIONS.length]);
    expect(get(ringtone)).toBe('owner:Sample-Tone');
    expect(preview).toHaveBeenCalledWith('owner:Sample-Tone');
    expect(get(notificationTone)).toBe('default');
  });

  it('choosing a notification tone is separate from the ring', async () => {
    const preview = vi.spyOn(audio, 'previewNotification').mockImplementation(() => {});
    const { getAllByTestId } = render(Sound);
    await fireEvent.click(getAllByTestId('notification-tone-option')[1]);
    expect(get(notificationTone)).toBe('owner:Sample-Tone');
    expect(preview).toHaveBeenCalledWith('owner:Sample-Tone');
    expect(get(ringtone)).toBe('classic');
  });
});
