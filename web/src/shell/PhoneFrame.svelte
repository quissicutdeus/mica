<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from './messages';
  import { onMount, type Snippet } from 'svelte';
  import { fly } from '@mica/sdk';
  import { isBatteryDead } from './state/charge';
  import { stepVolume } from './state/audio';
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
  import { isLocked } from './state/lockScreen';
  import LockScreen from './LockScreen.svelte';

  /**
   * The phone's body: bezel, hole-punch camera, hardware buttons, and the lock screen —
   * the chrome `shared/devices.ts` says the phone has and the tablet does not. Everything
   * the two share (the status bar, the home indicator, the dead-battery takeover and the
   * gestures on them) lives in `frame/` since MICA-259, and `TabletFrame.svelte` composes
   * the same pieces around a different body.
   */

  let {
    transparent = false,
    onClose,
    children
  }: { transparent?: boolean; onClose: () => void; children: Snippet } = $props();
  let screenElement = $state<HTMLElement | null>(null);
  const wallpaper = $derived($wallpaperBackground);
  const themeStyle = $derived($themeStyleStore);

  onMount(() => {
    if (screenElement) {
      return enableDragScroll(screenElement);
    }
  });
</script>

<!-- Phone Frame.

     The fill is conditional, not just the screen's. `transparent` used to be applied
     only to the inner screen div while this one kept an unconditional `bg-gray-950` —
     near-black and fully opaque — so the camera viewfinder rendered as a black box in
     game no matter what the screen did. The bezel border stays either way; it is the
     phone body, not the display.

     Always the design size, from `state/device.ts`. The zoom is a `transform` on a
     wrapper in `Shell.svelte` and deliberately not here: `transition:fly` writes
     `transform` on this element, so a scale set alongside it would be overwritten for
     the duration of every open and close.

     The fly-in starts a frame's height and a margin below its resting place, so the
     frame is fully off screen at the start of the flight on the tallest frame there is
     rather than at a number that happened to clear 850.

     `|global`, since MICA-259 put a `{#if}` on the device between this element and
     `Shell.svelte`'s `{#if visible}`. A transition is local by default: it plays when its
     *own* block toggles and not when an ancestor's does, so with the device block created
     as part of the open the fly-in silently stopped — the exact regression MICA-86 fixed
     and `openAnimation.spec.ts` watches for. Global plays on any ancestor block, which is
     the open and the close, and still not on initial render (`main.ts` mounts with no
     `intro`), so a phone that starts open in game still gets no fly-in it should not. -->
<div
  transition:fly|global={{ y: $frame.height + 150, duration: 500 }}
  data-testid="phone-frame"
  data-device-frame="phone"
  style="width: {$frame.width}px; height: {$frame.height}px;"
  class="shadow-elevation-5 duration-medium ease-emphasized rounded-frame-outer relative border-[8px] border-gray-950 ring-1 ring-gray-600 transition-colors"
  class:bg-gray-950={!transparent || $isBatteryDead}
>
  <!-- Hardware Side Buttons -->
  <!-- Power / Screen Off Button -->
  <button
    class="duration-short ease-standard absolute top-[180px] -right-[13px] h-12 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600"
    onclick={onClose}
    title={$t('shell.power')}
    aria-label={$t('shell.power')}
  ></button>

  <!-- Volume Buttons -->
  <div class="absolute top-[250px] -right-[13px] flex flex-col gap-2">
    <button
      class="duration-short ease-standard h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(1)}
      disabled={$isBatteryDead}
      title={$t('shell.volumeUp')}
      aria-label={$t('shell.volumeUp')}
    ></button>
    <button
      class="duration-short ease-standard h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(-1)}
      disabled={$isBatteryDead}
      title={$t('shell.volumeDown')}
      aria-label={$t('shell.volumeDown')}
    ></button>
  </div>

  <!-- Screen.

       Also the theme root: `themeStyle` writes all 47 `--color-*` roles here as inline
       custom properties, and they inherit into every app inside. It has to be this
       element rather than the frame or the document — the bezel above is the physical
       phone body and stays outside the theme, and touching `document.documentElement`
       would leak across jsdom test files and need teardown.

       There is no `bg-*` fallback class. One used to sit here as
       `class:bg-gray-900={… && !activeWallpaper}`, which never applied: it tested a
       `$derived` object for falsiness. The opaque fill in normal mode comes from the
       wallpaper, and a `bg-surface` here would be worse than dead — it would occlude the
       game world behind the camera viewfinder in transparent mode.

       The wallpaper is one CSS value on one property. It used to be a Tailwind class for a
       preset and an inline `background` for anything else, chosen by a ternary on the
       wallpaper's `type` — which meant the class had to survive Tailwind's scanner (a
       renamed preset silently rendered nothing) and, worse, `from-cyan-900` compiles to
       `oklch()` inside a gradient with no hex fallback, so those presets would not have
       rendered in game at all. -->
  <div
    bind:this={screenElement}
    data-testid="phone-screen"
    class="rounded-frame-inner duration-medium ease-emphasized relative h-full w-full overflow-hidden transition-colors"
    style={`${!transparent && !$isBatteryDead ? `background: ${wallpaper};` : ''} ${themeStyle}`}
    class:bg-black={$isBatteryDead}
    class:bg-transparent={transparent && !$isBatteryDead}
  >
    <!-- On-Screen Volume HUD Overlay -->
    <VolumeHud />

    <!-- Notification Shade Overlay -->
    <NotificationShade />

    <!-- Take-it-off-the-home-screen drop target. Rendered here rather than in
         `Launcher.svelte` for the same reason the ghost is: a drag can begin on the home
         grid, the dock or an open folder popup, and all three need the same one target. -->
    <RemoveTarget />

    <!-- Drag ghost: renders above every layer regardless of which surface (App Drawer,
         home grid, dock, folder popup) started the drag. -->
    <DragGhost />

    <!-- Dead Phone Screen Overlay -->
    {#if $isBatteryDead}
      <DeadBatteryScreen />
    {/if}

    <!-- Lock Screen (MICA-60). Same takeover shape as the dead-battery overlay above —
         a full-surface `{#if}` rather than something living inside the content area — and
         deliberately below it in this file: a dead phone shows nothing at all, lock screen
         included, matching a real handset that cannot be unlocked with no charge either. -->
    {#if $isLocked && !$isBatteryDead}
      <LockScreen />
    {/if}

    <!-- Status Bar -->
    {#if !transparent && !$isBatteryDead && !$isLocked}
      <StatusBar />
    {/if}

    <!-- Hole Punch Camera. `z-80` — above every other layer in the shell, including the
         shade/drawer sheets (`z-55`) and the drag ghost (`z-70`), the current highest.
         It stands for a hole physically cut in the screen: nothing in the UI can ever
         cover a real one, so nothing here should be able to either — it used to sit at
         `z-30`, under the shade, and visibly vanished under its sheet as the shade was
         dragged down.

         `pointer-events-none` is what a real cutout gets for free and this one has to be
         told: it sits dead center of the status bar, exactly where a tap or the start of
         a drag-down-to-open-the-shade is likely to land, and once it was stacked above
         that button (rather than below it, as `z-30` left it) a plain `<div>` there
         would otherwise silently absorb the touch instead of letting it reach the
         button underneath. -->
    <div
      data-testid="camera-cutout"
      class="size-icon-lg pointer-events-none absolute top-2 left-1/2 z-80 -translate-x-1/2 rounded-full bg-black ring-1 ring-gray-800"
    ></div>

    <!-- Content Area -->
    {#if !$isBatteryDead && !$isLocked}
      <div class="h-full">
        {@render children()}
      </div>
    {/if}

    <HomeIndicator />
  </div>
</div>
