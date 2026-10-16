<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import MusicFrame from '../MusicFrame.svelte';

  /**
   * `MusicFrame` with `ready` bound and its inputs held as state, the way `NearbyMusicFrame`
   * and `MusicPlayer` hold them. Changed through the setters below rather than through
   * testing-library's `rerender`, whose prop update re-runs `MusicFrame`'s `url` effect and
   * drops `ready` back to false — something no real caller does.
   */
  let { url: initialUrl, volume: initialVolume }: { url: string; volume: number } = $props();
  let ready = $state(false);
  // svelte-ignore state_referenced_locally
  let url = $state(initialUrl);
  // svelte-ignore state_referenced_locally
  let volume = $state(initialVolume);

  export function setVolume(next: number): void {
    volume = next;
  }

  export function setUrl(next: string): void {
    url = next;
  }
</script>

<MusicFrame bind:ready {url} {volume} title="probe" />
