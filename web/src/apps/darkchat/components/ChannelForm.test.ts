// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-254: Create and Join must not submit a `<form>`. The add-on frame is
 * `sandbox="allow-scripts"` with no `allow-forms`, so Chromium (CEF included) blocks the
 * submission and its handler never runs — while jsdom, and the dev browser outside the frame,
 * run it happily. So this holds the shape, not just the behavior: no form element at all, a
 * click on the button and Enter in a field both reach `onsubmit`, and an IME's Enter does not.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';

import ChannelForm from './ChannelForm.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('darkchat', { en, de });

const setup = (mode: 'create' | 'join') => {
  const onsubmit = vi.fn();
  const { container } = render(ChannelForm, { props: { mode, onsubmit, oncancel: vi.fn() } });
  return { onsubmit, container };
};

const type = (testId: string, value: string) =>
  fireEvent.input(screen.getByTestId(testId), { target: { value } });

describe('ChannelForm', () => {
  it('renders no form, so the sandbox has nothing to block', () => {
    for (const mode of ['create', 'join'] as const) {
      const { container } = setup(mode);
      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('[type="submit"]')).toBeNull();
      container.remove();
    }
  });

  it('creates on a click of the button', async () => {
    const { onsubmit } = setup('create');
    await type('darkchat-name', ' Den ');
    await type('darkchat-alias', ' boss ');
    await fireEvent.click(screen.getByText<HTMLButtonElement>('Create'));
    expect(onsubmit).toHaveBeenCalledWith('Den', 'boss');
  });

  it('joins on Enter in a field, normalizing the code', async () => {
    const { onsubmit } = setup('join');
    await type('darkchat-join-code', 'k7qx2mpv');
    await type('darkchat-alias', 'shade');
    await fireEvent.keyDown(screen.getByTestId('darkchat-alias'), { key: 'Enter' });
    expect(onsubmit).toHaveBeenCalledWith('K7QX2MPV', 'shade');
  });

  it('leaves an IME composition alone, and an incomplete form unsent', async () => {
    const { onsubmit } = setup('join');
    await type('darkchat-join-code', 'K7QX');
    await type('darkchat-alias', 'shade');
    await fireEvent.keyDown(screen.getByTestId('darkchat-alias'), { key: 'Enter' });
    await type('darkchat-join-code', 'K7QX2MPV');
    await fireEvent.keyDown(screen.getByTestId('darkchat-alias'), {
      key: 'Enter',
      isComposing: true
    });
    expect(onsubmit).not.toHaveBeenCalled();
  });
});
