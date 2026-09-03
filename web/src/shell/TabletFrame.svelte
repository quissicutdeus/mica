<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { fly } from '@gphone/sdk';
  import { t } from './messages';
  import { stepVolume } from './state/audio';
  import { isBatteryDead } from './state/charge';
  import { enableDragScroll } from '../lib/phone/dragScroll';
  import { frame } from './state/device';
  import VolumeHud from './VolumeHud.svelte';
  import NotificationShade from './NotificationShade.svelte';
  import DragGhost from './DragGhost.svelte';
  import RemoveTarget from './RemoveTarget.svelte';
  import StatusBar from './frame/StatusBar.svelte';
  import HomeIndicator from './frame/HomeIndicator.svelte';
  import DeadBatteryScreen from './frame/DeadBatteryScreen.svelte';
  import { wallpaperBackground } from './state/wallpaper';
  import { themeStyleStore } from './state/theme';

  /**
   * The tablet's body (MICA-259): a 1280x800 landscape frame with a 12px bezel and a
   * tighter corner, drawn around the same status bar, home indicator and dead-battery
   * takeover the phone uses. What it does not have is what `shared/devices.ts` says it
   * lacks — no hole-punch, no lock screen until the tablet has an identity of its own to
   * lock (MICA-264), and no camera, so no transparent mode.
   *
   * It does have the power and volume keys. They were left off when this frame was first
   * written and the omission was invisible: the keybind still put the tablet away, so
   * nothing failed, there was simply no way to do it by hand — and a player who reaches
   * for the edge of a tablet expects to find them there.
   *
   * A second component rather than a prop on `PhoneFrame`: CEF is Chromium 103, so the
   * tablet is a second set of fixed constants and its own `transform: scale()` in
   * `Shell.svelte`, never a responsive layout, and a frame that branched on every
   * chrome flag would be the responsive phone this design exists to avoid.
   */

  let { onClose, children }: { onClose: () => void; children: Snippet } = $props();
  let screenElement = $state<HTMLElement | null>(null);
  const wallpaper = $derived($wallpaperBackground);
  const themeStyle = $derived($themeStyleStore);

  onMount(() => {
    if (screenElement) {
      return enableDragScroll(screenElement);
    }
  });
</script>

<!-- Always the design size, from `state/device.ts`; the zoom is `Shell.svelte`'s
     wrapper, for the reason `PhoneFrame.svelte` gives, and `|global` for the reason it
     gives too. `data-device-frame` is what `DragGhost` measures the zoom from, on either
     frame. -->
<div
  transition:fly|global={{ y: $frame.height + 150, duration: 500 }}
  data-testid="tablet-frame"
  data-device-frame="tablet"
  style="width: {$frame.width}px; height: {$frame.height}px;"
  class="shadow-elevation-5 rounded-frame-outer-tablet relative border-[12px] border-gray-950 bg-gray-950 ring-1 ring-gray-600"
>
  <!-- The phone's side keys, rotated onto the top edge, because that is the edge a
       landscape tablet actually carries them on. Same parts throughout — 5px of travel
       proud of the bezel, power set apart from the volume pair — turned through ninety
       degrees: `w`/`h` swap, `rounded-r-md` becomes `rounded-t-md`, and the `-13px` that
       cleared the phone's 8px bezel becomes `-17px` for this one's 12px.

       Toward the left corner rather than centred: they sit above the launcher's first
       column, well clear of the status bar's own icons at the far right. -->
  <button
    class="duration-short ease-standard absolute -top-[17px] left-[120px] h-[5px] w-12 cursor-pointer rounded-t-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600"
    onclick={onClose}
    title={$t('shell.power')}
    aria-label={$t('shell.power')}
  ></button>

  <div class="absolute -top-[17px] left-[190px] flex gap-2">
    <button
      class="duration-short ease-standard h-[5px] w-10 cursor-pointer rounded-t-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(1)}
      disabled={$isBatteryDead}
      title={$t('shell.volumeUp')}
      aria-label={$t('shell.volumeUp')}
    ></button>
    <button
      class="duration-short ease-standard h-[5px] w-10 cursor-pointer rounded-t-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(-1)}
      disabled={$isBatteryDead}
      title={$t('shell.volumeDown')}
      aria-label={$t('shell.volumeDown')}
    ></button>
  </div>
  <!-- Screen. The theme root, exactly as on the phone: `themeStyle` writes every
       `--color-*` role here as an inline custom property. -->
  <div
    bind:this={screenElement}
    data-testid="tablet-screen"
    class="rounded-frame-inner-tablet relative h-full w-full overflow-hidden"
    style={`${!$isBatteryDead ? `background: ${wallpaper};` : ''} ${themeStyle}`}
    class:bg-black={$isBatteryDead}
  >
    <VolumeHud />
    <NotificationShade />
    <RemoveTarget />
    <DragGhost />

    {#if $isBatteryDead}
      <DeadBatteryScreen />
    {:else}
      <StatusBar />
      <div class="h-full">
        {@render children()}
      </div>
    {/if}

    <HomeIndicator />
  </div>
</div>
