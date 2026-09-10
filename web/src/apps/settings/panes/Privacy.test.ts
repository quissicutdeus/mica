// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * The Streamer Mode switch on the Privacy pane (MICA-249).
 *
 * The pane is the only place the flag is set, and the switch is the only control. What is
 * pinned is the wiring: the switch reads the shell's store and writes it back, and the
 * write lands in the `settings` namespace so it follows the character like every other
 * toggle in this app. What the flag does to a picture is `MediaThumb.test.ts`.
 *
 * In-process facets, standing in for the shell (MICA-172).
 */
import '../../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { useStorage } from '@mica/sdk';
import { registerMessages } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';
import Privacy from './Privacy.svelte';
import { setStreamerMode, streamerMode } from '../../../shell/state/streamerMode';

// `index.svelte` registers Settings' catalog for the running phone; this test mounts one
// pane without it, so it registers the same catalog itself (MICA-214).
registerMessages('settings', { en, de });

// jsdom has no Web Animations API and some SDK transitions call it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    finished: Promise.resolve(),
    cancel: vi.fn(),
    finish: vi.fn()
  });
}

describe('Privacy pane', () => {
  beforeEach(() => setStreamerMode(false));

  it('still shows the notice, and a Streamer Mode switch that starts off', () => {
    const { getByText, getByRole } = render(Privacy);
    expect(getByText(/can be read by its administrators/)).toBeTruthy();
    const toggle = getByRole('switch', { name: 'Streamer Mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('flips the shell store and persists it under settings', async () => {
    const { getByRole } = render(Privacy);
    const toggle = getByRole('switch', { name: 'Streamer Mode' });
    await fireEvent.click(toggle);
    expect(get(streamerMode)).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(useStorage('settings').getItem<boolean>('streamerMode', false)).toBe(true);

    await fireEvent.click(toggle);
    expect(get(streamerMode)).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reflects a change made elsewhere', async () => {
    const { getByRole } = render(Privacy);
    setStreamerMode(true);
    await Promise.resolve();
    expect(getByRole('switch', { name: 'Streamer Mode' }).getAttribute('aria-checked')).toBe(
      'true'
    );
  });
});
