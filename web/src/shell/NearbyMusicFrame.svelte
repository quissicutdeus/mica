<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * One other person's music. MICA-111 phase 2.
   *
   * The counterpart to `MusicPlayer.svelte`, and deliberately almost empty next to it.
   * That asymmetry is the design: your own playback has a queue, a position, a seek, a
   * repeat mode and an error you can act on, and a broadcast coming out of somebody else's
   * phone has none of those. There is nothing here to skip, nothing to scrub, and nothing
   * to report back — `reportPlayerState` and its neighbours are `state/music.ts`'s way of
   * hearing about *this phone's* track, and feeding a stranger's `ended` into them would
   * advance your queue because somebody down the street finished a song.
   *
   * So this component does exactly three things: it plays the right source, at the right
   * volume, from the right place in it. Everything else about the frame — the sandbox, the
   * handshake, the origin check — is `MusicFrame.svelte`'s and is shared with the local
   * player, which is the only thing the two concepts have in common.
   *
   * ## Where it starts, and why that is in the URL
   *
   * A broadcast was already running before you walked into range, so it joins at
   * `now - startedAt` (`lib/phone/musicRanking.ts`). That offset is an `embedUrlFor` parameter
   * rather than a `seekTo` after load: a seek is a second command racing the autoplay it
   * is correcting, and the audible failure is the first seconds of the song playing before
   * it jumps — on every join, for everyone in range.
   *
   * The offset is fixed when the source appears and is not recomputed while it plays
   * (`state/nearbyMusic.ts` caches it per source). If it moved, the URL would move, and
   * `MusicFrame` keys its element on the URL — so a fresh number on every distance tick
   * would be a fresh YouTube player on every distance tick.
   *
   * ## Pause, and the one thing the server has to do for it
   *
   * A paused broadcaster is held rather than torn down: they are still standing there and
   * are about to press play again, and rebuilding the player for a five-second pause is a
   * reload and a re-buffer for everyone in earshot.
   *
   * When they resume, the phone is *behind* by however long the pause lasted, and it
   * cannot know that number — it was never told. The fix is on the server side of the
   * contract: moving `startedAt` forward by the pause makes the source signature change,
   * which rebuilds this frame at the correct offset by the ordinary route. Without that,
   * a resumed broadcast plays from where it was paused and drifts by the length of the
   * pause, which is a tolerable failure and not a silent one.
   *
   * ## Failures are nobody's to fix here
   *
   * A remote source whose uploader disabled embedding simply does not play, and there is
   * no error state for it. `MusicPlayer.svelte` surfaces its own failures because a person
   * can skip or remove the track; nothing you can do to this phone changes what is in
   * somebody else's queue, and a toast saying so is noise about a stranger's problem.
   */
  import MusicFrame from './MusicFrame.svelte';
  import { embedUrlFor, musicOutputVolume, playerCommand } from './state/music';
  import type { AudibleBroadcast } from '@mica/sdk';

  interface Props {
    broadcast: AudibleBroadcast;
  }

  let { broadcast }: Props = $props();

  let player = $state<{ send: (message: string) => void } | undefined>();
  let ready = $state(false);
  /** The last transport command written, so an unchanged pause state is not resent. */
  let lastCommand: string | null = null;

  const origin = typeof window === 'undefined' ? undefined : window.location.origin;

  const url = $derived(
    embedUrlFor({ videoId: broadcast.videoId, playlistId: broadcast.playlistId }, origin, {
      start: broadcast.startAt
    })
  );

  /**
   * The volume this comes out at: the listener's own music volume, scaled by how far away
   * the broadcaster is.
   *
   * `musicOutputVolume` and not a channel of its own, deliberately. Music is music: a
   * person turning the music slider down to hear themselves think means all of it, and a
   * second slider that also had to be found would be a second thing to get wrong. It is
   * the *ducked* value for the same reason — a ringing phone has to win over the street as
   * well as over your own track (`state/music.ts`).
   *
   * The attenuation is the game client's, already computed from distance on its tick. The
   * phone never learns where anybody is standing; it multiplies.
   *
   * **A paused broadcast is silent as well as paused**, and the belt is not redundant with
   * the braces. The embed URL carries `autoplay=1` and the URL is deliberately not keyed on
   * `paused` (that would rebuild the player every time somebody tapped pause), so walking
   * into range of a paused broadcaster loads a frame that starts playing and is stopped a
   * moment later by the command below — audibly, if the buffer filled first. Loading it at
   * zero costs nothing and there is nothing to hear in the gap.
   */
  const volume = $derived(broadcast.paused ? 0 : $musicOutputVolume * broadcast.attenuation);

  const title = $derived(`Nearby music from ${broadcast.label ?? 'someone nearby'}`);

  $effect(() => {
    const command = broadcast.paused ? 'pauseVideo' : 'playVideo';
    if (!ready || !url) return;
    if (command === lastCommand) return;
    lastCommand = command;
    player?.send(playerCommand(command));
  });

  // A new source is a new element, so the command guard starts over.
  $effect(() => {
    void url;
    lastCommand = null;
  });
</script>

{#if url}
  <MusicFrame bind:this={player} bind:ready {url} {volume} {title} />
{/if}
