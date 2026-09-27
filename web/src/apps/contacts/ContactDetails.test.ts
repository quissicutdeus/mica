// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * A contact's ringtone picker lists the built-ins and the owner's sounds (MICA-256).
 * In-process facets, standing in for the shell (MICA-172).
 */
import '../../host/registerFacets';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { registerMessages, type Contact } from '@mica/sdk';
import en from './locales/en.json';
import de from './locales/de.json';
import ContactDetails from './components/ContactDetails.svelte';
import { audio, RINGTONE_OPTIONS } from '../../shell/state/audio';
import { ownerConfig, DEFAULT_OWNER_CONFIG } from '../../shell/state/ownerConfig';

registerMessages('contacts', { en, de });

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    finished: Promise.resolve(),
    cancel: vi.fn(),
    finish: vi.fn()
  });
}

const contact = (): Contact =>
  ({ id: 1, firstname: 'Ada', lastname: 'L', phone: '555', favorite: false }) as Contact;

const mount = (c: Contact) =>
  render(ContactDetails, {
    contact: c,
    isEditing: true,
    busy: false,
    recentMessages: [],
    messageCount: 0,
    oncall: () => {},
    onmessage: () => {},
    onshare: () => {},
    ondelete: () => {},
    onsave: () => {},
    ontogglefavorite: () => {},
    onpickphoto: () => {},
    onedit: () => {}
  });

describe('contact ringtone picker', () => {
  afterEach(() => {
    ownerConfig.set(DEFAULT_OWNER_CONFIG);
    vi.restoreAllMocks();
  });

  it('offers the system default, the built-ins and the owner sounds', () => {
    ownerConfig.set({
      ...DEFAULT_OWNER_CONFIG,
      sounds: [{ id: 'owner:Sample-Tone', label: 'Sample Tone', url: '/x/a.wav' }]
    });
    const { getAllByTestId } = mount(contact());
    expect(getAllByTestId('contact-ringtone-option').map((el) => el.textContent?.trim())).toEqual([
      'System default',
      ...RINGTONE_OPTIONS.map((o) => o.label),
      'Sample Tone'
    ]);
  });

  it('choosing an owner sound sets the override and previews it; default clears it', async () => {
    ownerConfig.set({
      ...DEFAULT_OWNER_CONFIG,
      sounds: [{ id: 'owner:Sample-Tone', label: 'Sample Tone', url: '/x/a.wav' }]
    });
    const preview = vi.spyOn(audio, 'preview').mockImplementation(() => {});
    const c = contact();
    const { getAllByTestId } = mount(c);
    const options = getAllByTestId('contact-ringtone-option');
    await fireEvent.click(options[options.length - 1]);
    expect(c.ringtone).toBe('owner:Sample-Tone');
    expect(preview).toHaveBeenCalledWith('owner:Sample-Tone');
    await fireEvent.click(options[0]);
    expect(c.ringtone).toBeNull();
  });
});
