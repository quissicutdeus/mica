<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * Everybody else's music, as many players as the cap allows. MICA-111 phase 2.
   *
   * Mounted by `Shell.svelte` beside `MusicPlayer.svelte` and outside its `{#if visible}`
   * block, for a sharper reason than the local player's: your own track survives the phone
   * being put away because you asked for it, and other people's music has to survive it
   * because **you never asked for it at all**. A broadcast that only played while the phone
   * was open would be a boombox you have to hold up to hear.
   *
   * `audibleBroadcasts` has already applied the mute list and the cap
   * (`state/nearbyMusic.ts`, `lib/phone/musicRanking.ts`), so this renders it and makes no
   * decisions. That is why there is no filtering here and no `{#if}` beyond the list:
   * a broadcast leaving the list is a player torn down, which is what muting somebody has
   * to feel like, and a rule that lived here would be a rule the tests could not reach
   * without a DOM.
   *
   * **Keyed by `token`, not by index and not by `source`.** Two people at almost the same distance swap
   * ranking positions as they move, and an index key would rebuild both players on the
   * swap — a reload and a re-buffer for a change that is not a change. Keyed by id, a
   * reorder moves nothing and only a genuine arrival or eviction creates or destroys a
   * frame. (`INCUMBENT_MARGIN` is what stops the pair thrashing in and out of the cap
   * itself; this is the other half of the same problem.)
   *
   * `token` rather than `source` because it is the person: a broadcaster who reconnects
   * mid-song gets a new server id, and keying on that would tear their player down and
   * build an identical one.
   */
  import NearbyMusicFrame from './NearbyMusicFrame.svelte';
  import { audibleBroadcasts } from './state/nearbyMusic';
</script>

{#each $audibleBroadcasts as broadcast (broadcast.token)}
  <NearbyMusicFrame {broadcast} />
{/each}
