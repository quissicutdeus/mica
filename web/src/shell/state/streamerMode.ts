// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readable } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { currentApp } from './navigation';
import { isPhoneOpen } from './phoneOpen';

/**
 * Streamer mode (MICA-249): every player-supplied image is blurred until tapped.
 *
 * A message attachment or a marketplace photo opening on stream is a moderation problem
 * for the streamer, and the phone cannot know what a picture holds. So the choice is the
 * player's, made once, and every image surface honours it — which is `sdk/ui/MediaThumb`,
 * the one renderer every player-supplied still goes through.
 *
 * State the phone itself owns, so it lives here rather than in `services/`: no table of
 * its own. `usePersisted` under `settings` is the same route every other toggle in Settings
 * takes — a `localStorage` cache in front of the settings service, synced per character
 * (`host/settingsSync.ts`).
 *
 * ## Why there is a generation counter
 *
 * A reveal is per-instance component state in `MediaThumb`, and it resets when the thumb
 * unmounts. That is the whole story for a detail view, which mounts and unmounts as it is
 * opened and closed. It is not enough for a resident app: Media's grid and a Messages
 * thread stay mounted while the app is backgrounded, so a picture revealed there would
 * still be showing when the app next came to the front — with the streamer no longer
 * expecting it. `revealGeneration` bumps whenever every revealed picture should hide again:
 * the flag flips, the foreground app changes, or the device closes. A thumb subscribes and
 * re-blurs on any bump, wherever it is mounted.
 */

/** A stored value is a value a player can edit; anything unrecognized is off. */
export const sanitizeStreamerMode = (stored: unknown): boolean => stored === true;

export const streamerMode = usePersisted<boolean>('settings', 'streamerMode', false, {
  sanitize: sanitizeStreamerMode
});

export const setStreamerMode = (on: boolean) => streamerMode.set(sanitizeStreamerMode(on));

/**
 * Bumps on every event after which a revealed picture should be hidden again. The value
 * itself means nothing; a subscriber only reacts to it changing. Live only while something
 * subscribes, which is the store contract and costs nothing when nothing is watching.
 */
export const revealGeneration = readable(0, (set) => {
  let generation = 0;
  let armed = false;
  const bump = () => {
    // Every source fires once on subscribe; that is the initial value, not a change.
    if (!armed) return;
    generation += 1;
    set(generation);
  };
  const unsubscribers = [
    streamerMode.subscribe(bump),
    currentApp.subscribe(bump),
    isPhoneOpen.subscribe(bump)
  ];
  armed = true;
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
});
