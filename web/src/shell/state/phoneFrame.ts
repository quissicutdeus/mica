// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived } from 'svelte/store';
import { FRAME_IDS, type FrameId } from '@mica/shared/ownerConfig';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { ownerConfig } from './ownerConfig';

/**
 * How the phone's body is drawn (MICA-236): the camera cutout and the bezel colour. Purely
 * cosmetic and always inside the fixed 400x850 box — the bezel is the same 8px in every
 * variant — so no app's layout can notice which one is on.
 *
 * The player's choice is `''` until they make one, and the owner's `defaultFrame` stands in
 * for that, overlaid with `derived` rather than written into storage so a later owner
 * change still reaches everyone who never chose. Settings writes the same two keys through
 * `usePersisted` — an app may not import shell state.
 */
export const FRAME_COLORS = ['black', 'graphite', 'silver'] as const;
export type FrameColor = (typeof FRAME_COLORS)[number];

/** Hex literals: a bezel is physical, so it stays out of the M3 theme like the bezel did. */
export const FRAME_COLOR_HEX: Record<FrameColor, string> = {
  black: '#030712',
  graphite: '#374151',
  silver: '#d1d5db'
};

export const isFrameId = (value: unknown): value is FrameId =>
  (FRAME_IDS as readonly string[]).includes(value as string);

export const isFrameColor = (value: unknown): value is FrameColor =>
  (FRAME_COLORS as readonly string[]).includes(value as string);

/** The player's choice, '' for none. */
export const frameSetting = usePersisted<string>('settings', 'frame', '', {
  sanitize: (stored) => (isFrameId(stored) ? stored : '')
});

export const frameColorSetting = usePersisted<string>('settings', 'frameColor', '', {
  sanitize: (stored) => (isFrameColor(stored) ? stored : '')
});

/** The player's frame choice; '' means follow the owner. An unknown id is ignored. */
export const setFrame = (id: string): void => {
  if (id === '' || isFrameId(id)) frameSetting.set(id);
};

export const setFrameColor = (id: string): void => {
  if (id === '' || isFrameColor(id)) frameColorSetting.set(id);
};

export const activeFrame = derived([frameSetting, ownerConfig], ([$setting, $owner]): FrameId =>
  isFrameId($setting) ? $setting : isFrameId($owner.defaultFrame) ? $owner.defaultFrame : 'classic'
);

export const activeFrameColor = derived(frameColorSetting, ($setting): FrameColor =>
  isFrameColor($setting) ? $setting : 'black'
);
