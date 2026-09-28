// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-298: the lightness and opacity sliders had no accessible name — a screen reader
 * announced only "slider", found by MICA-295's tablet a11y sweep. Asserting on the
 * `aria-label` catches a regression back to an unlabeled `<input type="range">` without
 * needing a real screen reader or axe in this suite.
 *
 * In-process facets, standing in for the shell (MICA-172).
 */
import '../../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';
import ColorWheelPicker from './ColorWheelPicker.svelte';

registerMessages('settings', { en, de });

describe('ColorWheelPicker slider accessible names', () => {
  it('gives the lightness and opacity sliders an aria-label', () => {
    const { getByRole } = render(ColorWheelPicker, {
      props: { color: '#3b82f6', onchange: () => {} }
    });

    const sliders = getByRole('slider', { name: en['colorPicker.lightnessLabel'] });
    expect(sliders).toBeTruthy();

    const opacitySlider = getByRole('slider', { name: en['colorPicker.opacityLabel'] });
    expect(opacitySlider).toBeTruthy();
  });
});
