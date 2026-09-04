// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { captureZoomBoost } from './host/seam/captureZoom';

/**
 * Draws the phone at its largest normal size while true, instead of the player's Display
 * setting, so a capture around it gets more real on-screen pixels.
 *
 * `core: true` only — exported from `@mica/sdk/core`, not `@mica/sdk`. This is a lever
 * on the shell's own rendering, not a capability any add-on has a legitimate reason to
 * pull: a sandboxed iframe forcing the whole phone bigger is a griefing vector, not a
 * feature, so it carries no host-protocol twin the way `useCamera`'s fields do.
 */
export function useCaptureZoomBoost() {
  return captureZoomBoost;
}
