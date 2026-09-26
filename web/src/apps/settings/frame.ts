// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { usePersisted, useDisplayWrite } from '@mica/sdk';

/**
 * The player's own phone-body choices (MICA-236), read as Settings shows them: '' for the
 * frame is "server default". The write goes through `useDisplayWrite`, because a
 * second `usePersisted` instance of the same key does not tell the shell's copy; the local
 * store is set alongside so this pane's highlight follows.
 */
export const frameSetting = usePersisted<string>('settings', 'frame', '');
export const frameColorSetting = usePersisted<string>('settings', 'frameColor', '');

export const FRAME_CHOICES = ['classic', 'notch', 'punch'] as const;
export const FRAME_COLOR_CHOICES = [
  { id: 'black', hex: '#030712' },
  { id: 'graphite', hex: '#374151' },
  { id: 'silver', hex: '#d1d5db' }
] as const;

const { setFrame, setFrameColor } = useDisplayWrite();

export const chooseFrame = (id: string): void => {
  setFrame(id);
  frameSetting.set(id);
};

export const chooseFrameColor = (id: string): void => {
  setFrameColor(id);
  frameColorSetting.set(id);
};
