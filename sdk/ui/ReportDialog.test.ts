// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * In-process facets, because a unit test stands in for the shell (MICA-176). The frame case
 * below swaps in the real iframe twin for `phoneNotification` alone, over a stubbed wire.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';

const dialog = vi.hoisted(() => ({
  submit: vi.fn(async (_input: unknown) => {}),
  phoneNotification: (): unknown => ({}),
  remoteCall: vi.fn(async (..._args: unknown[]): Promise<unknown> => 'toast-1')
}));

vi.mock('../host/useReport', () => ({
  useReport: () => ({ submit: dialog.submit })
}));
vi.mock('../host/usePhoneNotification', () => ({
  usePhoneNotification: () => dialog.phoneNotification()
}));
// The wire under the twin: a call is a spy, a store sits on its seed.
vi.mock('../host/iframe/remote', async (importOriginal) => {
  const { readable } = await import('svelte/store');
  return {
    ...(await importOriginal<typeof import('../host/iframe/remote')>()),
    remoteCall: dialog.remoteCall,
    remoteStore: (_facet: string, _args: unknown, _member: string, initial: unknown) =>
      readable(initial)
  };
});

// jsdom has no `Element.animate`, and the sheet fades in through `lib/motion`. The stub is
// `RecentlyDeleted.test.ts`'s, which resolves `onfinish` the way a real animation would.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn(function mockAnimate() {
    let onfinish: (() => void) | null = null;
    queueMicrotask(() => onfinish?.());
    return {
      cancel: () => {},
      finish: () => {},
      startTime: 0,
      currentTime: 0,
      effect: { getComputedTiming: () => ({ duration: 0 }) },
      set onfinish(fn: (() => void) | null) {
        onfinish = fn;
      },
      get onfinish() {
        return onfinish;
      }
    };
  }) as unknown as typeof Element.prototype.animate;
}

import ReportDialog from './ReportDialog.svelte';

const submitReport = async () => {
  const onclose = vi.fn();
  const { getByRole } = render(ReportDialog, {
    targetTable: 'mica_glimpse_posts',
    targetId: 9,
    appId: 'glimpse',
    onclose
  });
  await fireEvent.click(getByRole('button', { name: 'Report' }));
  return onclose;
};

/**
 * MICA-254. The dialog tells the player how the report went. A core app's `toast` has `show`;
 * an add-on frame's `toast` is a read-only twin without it, and calling it anyway threw after
 * the report had already been sent.
 */
describe('ReportDialog', () => {
  beforeEach(() => {
    dialog.submit.mockReset().mockResolvedValue(undefined);
    dialog.remoteCall.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('in-process', () => {
    let show: ReturnType<typeof vi.fn>;
    let sendNotification: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      show = vi.fn();
      sendNotification = vi.fn();
      dialog.phoneNotification = () => ({ toast: { show }, sendNotification });
    });

    it('toasts success under the calling app, and closes', async () => {
      const onclose = await submitReport();
      await waitFor(() => expect(onclose).toHaveBeenCalled());
      expect(show).toHaveBeenCalledWith({
        type: 'success',
        app: 'glimpse',
        message: 'Report sent for review'
      });
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it('toasts the failure under the calling app, and stays open', async () => {
      dialog.submit.mockRejectedValue(new Error('nope'));
      const onclose = await submitReport();
      await waitFor(() => expect(show).toHaveBeenCalled());
      expect(show.mock.calls[0][0]).toMatchObject({ type: 'error', app: 'glimpse' });
      expect(onclose).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    });
  });

  describe("in an add-on's frame", () => {
    beforeEach(async () => {
      const twin = await import('../host/iframe/facets/phoneNotification');
      dialog.phoneNotification = twin.phoneNotification;
    });

    it('has no toast.show to call, which is the premise', () => {
      const facet = dialog.phoneNotification() as { toast: Record<string, unknown> };
      expect(facet.toast.show).toBeUndefined();
    });

    it('tells the player the report was sent, with no app named, and closes', async () => {
      const onclose = await submitReport();
      await waitFor(() => expect(onclose).toHaveBeenCalled());
      expect(dialog.remoteCall).toHaveBeenCalledWith('phoneNotification', [], 'sendNotification', {
        type: 'success',
        message: 'Report sent for review'
      });
    });

    it('tells the player the report failed, and stays open', async () => {
      dialog.submit.mockRejectedValue(new Error('nope'));
      const onclose = await submitReport();
      await waitFor(() => expect(dialog.remoteCall).toHaveBeenCalled());
      expect(dialog.remoteCall.mock.calls[0].slice(0, 3)).toEqual([
        'phoneNotification',
        [],
        'sendNotification'
      ]);
      expect(dialog.remoteCall.mock.calls[0][3]).toMatchObject({ type: 'error' });
      expect(dialog.remoteCall.mock.calls[0][3]).not.toHaveProperty('app');
      expect(onclose).not.toHaveBeenCalled();
    });

    it('swallows a refused notice rather than failing a report that went', async () => {
      dialog.remoteCall.mockRejectedValueOnce(new Error('refused'));
      const onclose = await submitReport();
      await waitFor(() => expect(onclose).toHaveBeenCalled());
      await waitFor(() => expect(console.warn).toHaveBeenCalled());
      expect(dialog.submit).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * MICA-406. The sheet opens over a screen whose own title is an `h1`, so its heading is an
 * `h2`, as every sdk/ui dialog's is; an `h3` there is axe's `heading-order`.
 */
describe('ReportDialog heading', () => {
  it('is a level-2 heading inside a dialog named by the same words', () => {
    const { getByRole, container } = render(ReportDialog, {
      targetTable: 'mica_glimpse_posts',
      targetId: 9,
      appId: 'glimpse',
      onclose: () => {}
    });
    expect(getByRole('dialog', { name: 'Report content' }).getAttribute('aria-modal')).toBe('true');
    expect(getByRole('heading', { level: 2, name: 'Report content' })).toBeTruthy();
    expect(container.querySelector('h3')).toBeNull();
  });
});
