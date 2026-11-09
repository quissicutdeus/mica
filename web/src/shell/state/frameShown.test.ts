// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchNui } = vi.hoisted(() => ({ fetchNui: vi.fn(async (): Promise<unknown> => true) }));
vi.mock('../../nui/fetchNui', () => ({ fetchNui }));

import { acknowledgeFrameShown } from './frameShown';

/**
 * The page's answer to the client's `setVisible` (MICA-475): sent once the device's frame is in
 * the document, for the device it was asked for, and never for a frame that is not.
 * `Shell.frameShown.test.ts` holds the shell to asking only on a show, and to a frame that
 * failed to mount.
 */

const sent = () => fetchNui.mock.calls.filter((call) => (call as unknown[])[0] === 'frameShown');

/** A frame root as the frames mark theirs. */
const frameFor = (device: string): HTMLElement => {
  const element = document.createElement('div');
  element.dataset.deviceFrame = device;
  return element;
};

let attached: HTMLElement[] = [];
const attach = (element: HTMLElement): HTMLElement => {
  document.body.append(element);
  attached.push(element);
  return element;
};

beforeEach(() => {
  fetchNui.mockClear();
});

afterEach(() => {
  for (const element of attached) element.remove();
  attached = [];
});

describe('acknowledgeFrameShown (MICA-475)', () => {
  it.each(['phone', 'tablet'] as const)(
    'answers for the %s once its frame is in the document, not on receipt',
    async (device) => {
      const frame = attach(frameFor(device));
      const frameOf = vi.fn(() => frame);
      const done = acknowledgeFrameShown(device, frameOf);
      expect(sent(), 'not on receipt').toEqual([]);
      expect(frameOf, 'asked only after the flush').not.toHaveBeenCalled();
      await done;
      expect(frameOf).toHaveBeenCalledWith(device);
      expect(sent()).toEqual([['frameShown', { device }]]);
    }
  );

  it('sends nothing when the render produced no frame', async () => {
    await acknowledgeFrameShown('phone', () => null);
    expect(sent()).toEqual([]);
  });

  it('sends nothing for a frame that exists but is not in the document', async () => {
    // A frame built and never attached, as a mount that threw part-way leaves it.
    await acknowledgeFrameShown('phone', () => frameFor('phone'));
    expect(sent()).toEqual([]);
  });

  it('never rejects when the client does not answer', async () => {
    fetchNui.mockRejectedValueOnce(new Error('no client'));
    const frame = attach(frameFor('phone'));
    await expect(acknowledgeFrameShown('phone', () => frame)).resolves.toBeUndefined();
    expect(sent()).toHaveLength(1);
  });
});
