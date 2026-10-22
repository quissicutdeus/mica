// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: in-process facets — a unit test stands in for the shell.
 */
import '../../../host/registerFacets';
import { afterEach, describe, it, expect } from 'vitest';
import { tick } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import type { JobLineThread } from '@mica/shared/types';
import { locale } from '../../../../../sdk/i18n';
import LineInbox from './LineInbox.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('jobs', { en, de });

const thread = (msAgo: number): JobLineThread => ({
  conversation_id: 1,
  from: '555-0100',
  last_message: 'Need a tow',
  last_at: new Date(Date.now() - msAgo).toISOString(),
  awaiting_reply: false
});

const renderInbox = (threads: JobLineThread[]) =>
  render(LineInbox, {
    props: { threads, loaded: true, failed: false, nameFor: (n) => n, onopen: () => {} }
  });

const DAY = 24 * 60 * 60 * 1000;

describe('LineInbox relative time (MICA-412)', () => {
  afterEach(() => locale.set('en'));

  it('words a thread\'s age the SDK\'s way: a date past yesterday, never "3d ago"', () => {
    const at = thread(3 * DAY);
    renderInbox([at]);
    const date = new Date(at.last_at).toLocaleDateString('en', { month: 'short', day: 'numeric' });
    expect(screen.getByText(date)).toBeTruthy();
    expect(screen.queryByText('3d ago')).toBeNull();
  });

  it('says Yesterday a day back', () => {
    renderInbox([thread(30 * 60 * 60 * 1000)]);
    expect(screen.getByText('Yesterday')).toBeTruthy();
  });

  it('re-words on a locale switch', async () => {
    renderInbox([thread(5 * 60 * 1000)]);
    expect(screen.getByText('5m ago')).toBeTruthy();
    locale.set('de');
    await tick();
    expect(screen.getByText('vor 5 Min.')).toBeTruthy();
  });
});
