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
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { NotificationItem } from '@mica/shared/types';

// The loaders reach the transport and would overwrite the rows this file seeds.
vi.mock('../services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/notifications')>()),
  loadShadeNotifications: vi.fn(async () => {}),
  loadUnreadCounts: vi.fn(async () => {}),
  loadNotificationHistory: vi.fn(async () => []),
  markNotificationsOpened: vi.fn(async () => {}),
  clearNotifications: vi.fn(async () => {}),
  clearAllNotifications: vi.fn(async () => {}),
  restoreNotifications: vi.fn(async () => {})
}));

import NotificationShade from './NotificationShade.svelte';
import TrashIcon from '../../../sdk/ui/icons/TrashIcon.svelte';
import {
  clearNotifications,
  loadNotificationHistory,
  markNotificationsOpened,
  restoreNotifications,
  shadeNotifications
} from '../services/notifications';
import { isShadeOpen } from './state/shade';
import { locale } from '../../../sdk/i18n';

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

/** The body preview line, a block span inside the row's own button since MICA-411. */
const emptyParagraphs = (container: HTMLElement) =>
  [...container.querySelectorAll('p, .line-clamp-1, .line-clamp-2')].filter(
    (p) => !p.textContent?.trim()
  );

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

/**
 * Every row used to be a `div role="button"` wrapping its own clear or restore `<button>`:
 * axe's `nested-interactive`, and a role whose children are presentational, so the inner
 * control was unreachable to assistive tech. Since MICA-411 a row is a surface holding sibling
 * buttons — the row's own action stretched over it, the per-row control above that.
 */
describe('NotificationShade rows hold no control inside a control (MICA-411)', () => {
  const archived = (item: NotificationItem): NotificationItem => ({
    ...item,
    cleared_at: item.created_at
  });
  const fixtures = () => [
    row(1, 'settings', 'Developer Tools', 'Unlocked successfully.'),
    row(2, 'messages', 'Ursula', 'See you there'),
    row(3, 'messages', 'Trevor Philips', 'Where are you')
  ];

  /** Anything acting as a button that is not one, and any button with a control inside it. */
  const offenders = (container: HTMLElement) => [
    ...[...container.querySelectorAll('[role="button"]')].filter((el) => el.tagName !== 'BUTTON'),
    ...[...container.querySelectorAll('button')].filter((b) =>
      b.querySelector('button, a[href], input, select, textarea, [tabindex], [role="button"]')
    )
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    shadeNotifications.set(fixtures());
    isShadeOpen.set(true);
  });

  it('draws the active list, group opened, as sibling buttons', async () => {
    const { container, getByRole } = render(NotificationShade);
    await tick();
    await fireEvent.click(getByRole('button', { name: /^messages 2 notifications/ }));
    await tick();

    expect(getByRole('button', { name: /Trevor Philips/ })).toBeTruthy();
    expect(offenders(container).map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('draws the archive, group opened, as sibling buttons', async () => {
    vi.mocked(loadNotificationHistory).mockResolvedValue(fixtures().map(archived));
    const { container, getByRole } = render(NotificationShade);
    await tick();
    await fireEvent.click(getByRole('button', { name: 'Notification Archive' }));
    const header = await waitFor(() => getByRole('button', { name: /^messages 2 notifications/ }));
    await fireEvent.click(header);
    await tick();

    expect(getByRole('button', { name: /Trevor Philips/ })).toBeTruthy();
    expect(offenders(container).map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('opens a row from its own button, and clears from the clear button alone', async () => {
    const { getByRole } = render(NotificationShade);
    await tick();

    await fireEvent.click(getByRole('button', { name: /Developer Tools/ }));
    expect(markNotificationsOpened).toHaveBeenCalledWith([1]);

    await fireEvent.click(getByRole('button', { name: 'Clear notification' }));
    expect(clearNotifications).toHaveBeenCalledWith([1]);
    expect(markNotificationsOpened).toHaveBeenCalledTimes(1);
  });

  it('marks a group header as the disclosure it is', async () => {
    const { getByRole } = render(NotificationShade);
    await tick();
    const header = getByRole('button', { name: /^messages 2 notifications/ });

    expect(header.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('restores from the archive without drawing a trash can on the control', async () => {
    vi.mocked(loadNotificationHistory).mockResolvedValue(fixtures().map(archived));
    const { getByRole, getAllByRole } = render(NotificationShade);
    await tick();
    await fireEvent.click(getByRole('button', { name: 'Notification Archive' }));
    await fireEvent.click(
      await waitFor(() => getByRole('button', { name: /^messages 2 notifications/ }))
    );
    await tick();

    const trash = render(TrashIcon).container.querySelector('path')?.getAttribute('d');
    const restores = [
      ...getAllByRole('button', { name: 'Restore to Active notifications' }),
      getByRole('button', { name: 'Restore all messages notifications' })
    ];
    expect(restores).toHaveLength(4);
    for (const button of restores) {
      expect(button.querySelector('path')?.getAttribute('d')).not.toBe(trash);
    }

    await fireEvent.click(restores[0]);
    expect(restoreNotifications).toHaveBeenCalledWith([1]);
    expect(markNotificationsOpened).not.toHaveBeenCalled();
  });
});

/**
 * The shade's timestamps are the SDK's relative time (MICA-412), not a private English copy:
 * the same words every other surface uses, from the `ui` catalog, so they follow the phone's
 * language and re-format when it changes.
 */
describe('NotificationShade timestamps (MICA-412)', () => {
  const at = (id: number, msAgo: number): NotificationItem => ({
    ...row(id, `app${id}`, `Title ${id}`, ''),
    created_at: new Date(Date.now() - msAgo).toISOString()
  });

  beforeEach(() => {
    locale.set('en');
    isShadeOpen.set(true);
  });

  it('says "Yesterday" for a day-old row, where the private copy said "1d ago"', async () => {
    shadeNotifications.set([at(1, 25 * 60 * 60 * 1000)]);
    const { getByText, queryByText } = render(NotificationShade);
    await tick();

    expect(getByText('Yesterday')).toBeTruthy();
    expect(queryByText('1d ago')).toBeNull();
  });

  it('re-formats in the new language when the locale changes', async () => {
    shadeNotifications.set([at(1, 5 * 60 * 1000)]);
    const { getByText } = render(NotificationShade);
    await tick();
    expect(getByText('5m ago')).toBeTruthy();

    locale.set('de');
    await tick();
    expect(getByText('vor 5 Min.')).toBeTruthy();
  });
});
