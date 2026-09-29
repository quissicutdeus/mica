// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * Which facet set this file's subject resolves against — see `ToastHost.test.ts`. In-process,
 * because a unit test stands in for the shell.
 */
import '../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { NotificationItem } from '@mica/shared/types';

// The loaders reach the transport and would overwrite the rows this file seeds.
vi.mock('../services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/notifications')>()),
  loadShadeNotifications: vi.fn(async () => {}),
  loadUnreadCounts: vi.fn(async () => {})
}));

import NotificationShade from './NotificationShade.svelte';
import { shadeNotifications } from '../services/notifications';
import { isShadeOpen } from './state/shade';

// jsdom has no Web Animations API and the shade's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const row = (id: number, app: string, title: string, body: string): NotificationItem => ({
  id,
  citizenid: 'c1',
  app,
  kind: 'info',
  title,
  body,
  avatar: null,
  deep_link: null,
  read_at: null,
  cleared_at: null,
  created_at: new Date(Date.now() - id * 1000).toISOString(),
  updated_at: new Date(Date.now() - id * 1000).toISOString()
});

const emptyParagraphs = (container: HTMLElement) =>
  [...container.querySelectorAll('p')].filter((p) => !p.textContent?.trim());

/**
 * A Blabber DM's persisted notification carries no body at all (MICA-165: the text is sealed
 * on the server and the row must not hold it in the clear), so the shade meets a title-only
 * row. An empty string rendered as a paragraph is an empty line and, in a `space-y` stack, a
 * stray gap under the title — and this holds for any app, not just DMs.
 */
describe('NotificationShade with a body-less notification (MICA-165)', () => {
  beforeEach(() => {
    shadeNotifications.set([]);
    isShadeOpen.set(true);
  });

  it('renders a standalone title-only row with no empty paragraph', async () => {
    shadeNotifications.set([row(1, 'blabber', '@ada sent you a message', '')]);
    const { getByText, container } = render(NotificationShade);
    await tick();

    expect(getByText('@ada sent you a message')).toBeTruthy();
    expect(emptyParagraphs(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders a group whose latest row is title-only without an empty preview line', async () => {
    shadeNotifications.set([
      row(1, 'blabber', '@ada sent you a message', ''),
      row(2, 'blabber', '@bea sent you a message', '')
    ]);
    const { getByText, container } = render(NotificationShade);
    await tick();

    expect(getByText('@ada sent you a message')).toBeTruthy();
    expect(emptyParagraphs(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('undefined');
  });

  it('still renders the body when there is one', async () => {
    shadeNotifications.set([row(1, 'settings', 'Developer Tools', 'Unlocked successfully.')]);
    const { getByText } = render(NotificationShade);
    await tick();

    expect(getByText('Unlocked successfully.')).toBeTruthy();
  });
});
