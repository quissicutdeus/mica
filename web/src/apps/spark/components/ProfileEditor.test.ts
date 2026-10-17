// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-255: the profile editor must not submit a `<form>` — the add-on frame has no
 * `allow-forms`, so the submission is blocked there while jsdom runs it happily — and it holds
 * the server's limits: 18 to 99, one to four photos, a name. Dark Chat's `ChannelForm` test,
 * for the same reason.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import type { SparkProfile } from '@mica/shared/types';

import ProfileEditor from './ProfileEditor.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('spark', { en, de });

const held: SparkProfile = {
  id: 100,
  account_id: 30,
  display_name: 'Ada',
  age: 29,
  bio: null,
  looking_for: null,
  photos: [{ id: 1001, media: { kind: 'photo', data: 'aGk=' } }],
  photo_ids: [7],
  status: 'active'
};

const setup = (profile: SparkProfile | null) => {
  const onsave = vi.fn();
  const { container } = render(ProfileEditor, { props: { profile, onsave } });
  return { onsave, container };
};

const type = (testId: string, value: string) =>
  fireEvent.input(screen.getByTestId(testId), { target: { value } });

describe('ProfileEditor', () => {
  it('renders no form, so the sandbox has nothing to block', () => {
    const { container } = setup(null);
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[type="submit"]')).toBeNull();
  });

  it('cannot start without a photo', async () => {
    const { onsave } = setup(null);
    await type('spark-name', 'Ada');
    await type('spark-age', '29');
    expect(screen.getByTestId<HTMLButtonElement>('spark-save').disabled).toBe(true);
    await fireEvent.keyDown(screen.getByTestId('spark-name'), { key: 'Enter' });
    expect(onsave).not.toHaveBeenCalled();
  });

  it('saves the held photos by gallery id, trimmed, on a click', async () => {
    const { onsave } = setup(held);
    await type('spark-name', ' Ada L ');
    await type('spark-looking-for', '  ');
    await fireEvent.click(screen.getByTestId('spark-save'));
    expect(onsave).toHaveBeenCalledWith({
      display_name: 'Ada L',
      age: 29,
      bio: null,
      looking_for: null,
      photos: [{ photo_id: 7 }]
    });
  });

  it('refuses an age under 18 and says so, and leaves an IME Enter alone', async () => {
    const { onsave } = setup(held);
    await type('spark-age', '17');
    expect(screen.getByTestId('spark-age-hint').textContent).toContain('18 to 99');
    expect(screen.getByTestId<HTMLButtonElement>('spark-save').disabled).toBe(true);
    await type('spark-age', '30');
    await fireEvent.keyDown(screen.getByTestId('spark-name'), { key: 'Enter', isComposing: true });
    expect(onsave).not.toHaveBeenCalled();
    await fireEvent.keyDown(screen.getByTestId('spark-name'), { key: 'Enter' });
    expect(onsave).toHaveBeenCalledWith(expect.objectContaining({ age: 30 }));
  });
});
