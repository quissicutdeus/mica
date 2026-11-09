// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tick } from 'svelte';
import type { DeviceId } from '@mica/shared/devices';
import { fetchNui } from '../../nui/fetchNui';

/**
 * Tell the client that the frame its `setVisible` asked for is on the page (MICA-475).
 *
 * The client takes NUI focus when it sends `setVisible`, so every key goes to this page, and
 * starts a deadline (`client/lib/DeviceVisibility.ts`). If this answer does not arrive before
 * the deadline, it puts the device down to release focus. That rescues a player whose page
 * threw at boot or never loaded. Answering is the page's half of that, so it goes out only once
 * the frame exists, never on receipt.
 *
 * **What is checked is the frame, not the flag.** Svelte's flush (`tick`) has run the render
 * the flag scheduled. `frameOf` then answers the element that render produced, the frame's
 * `data-device-frame` root, and only one still in the document counts. A frame component that
 * throws while mounting escapes in Svelte's own flush. `tick` still resolves, and a `visible`
 * flag would still read true. But the frame was never attached, so no answer goes out, and the
 * client's deadline gives the player their keys back.
 *
 * **No `requestAnimationFrame`.** It runs only while the page is drawing, and CEF may not draw
 * while the game window is not focused. A device raised then, such as an incoming call or an
 * `OpenApp`, would be put down with its page alive. A paint proves nothing more than the
 * attached frame does anyway: that the game shows the page's texture is past what script can
 * observe.
 *
 * Only for the client's own `setVisible(true)`, which is the only open the client is waiting
 * on. The browser's self-open and a notification's tap open the frame with no client deadline
 * behind them.
 *
 * Never rejects: a failed answer is the client's deadline to handle, and nothing here can do
 * better.
 */
export const acknowledgeFrameShown = async (
  device: DeviceId,
  frameOf: (device: DeviceId) => Element | null | undefined
): Promise<void> => {
  try {
    await tick();
  } catch {
    // The render threw from this flush rather than its own; the frame check below sees it.
  }
  if (!frameOf(device)?.isConnected) return;
  await fetchNui('frameShown', { device }).catch(() => {});
};
