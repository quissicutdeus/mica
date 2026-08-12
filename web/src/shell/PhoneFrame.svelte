<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { formattedTime } from './state/time';
  import { goHome } from './state/navigation';
  import { displayCharge, isBatteryDead } from './state/charge';
  import { clampedSignalLevel } from './state/signal';
  import { bluetoothEnabled } from './state/bluetooth';
  import { stepVolume } from './state/audio';
  import { enableDragScroll } from '../lib/dragScroll';
  import { PHONE_HEIGHT, PHONE_WIDTH } from './state/display';
  import LightningWarningIcon from '../sdk/ui/icons/LightningWarningIcon.svelte';
  import SignalIcon from '../sdk/ui/icons/SignalIcon.svelte';
  import BluetoothIcon from '../sdk/ui/icons/BluetoothIcon.svelte';
  import VolumeHud from './VolumeHud.svelte';
  import NotificationShade from './NotificationShade.svelte';
  import { openShade, isShadeOpen, closeShade } from './state/shade';
  import { wallpaperBackground } from './state/wallpaper';
  import { themeStyleStore } from './state/theme';

  let { transparent = false, onClose, children } = $props();
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

     Always the design size, from `state/display.ts`. The zoom is a `transform` on a
     wrapper in `Shell.svelte` and deliberately not here: `transition:fly` writes
     `transform` on this element, so a scale set alongside it would be overwritten for
     the duration of every open and close. -->
<div
  transition:fly={{ y: 1000, duration: 500 }}
  data-testid="phone-frame"
  style="width: {PHONE_WIDTH}px; height: {PHONE_HEIGHT}px;"
  class="relative rounded-[3.5rem] border-[8px] border-gray-950 shadow-2xl ring-1 ring-gray-600 transition-colors duration-200"
  class:bg-gray-950={!transparent || $isBatteryDead}
>
  <!-- Hardware Side Buttons -->
  <!-- Power / Screen Off Button -->
  <button
    class="absolute top-[180px] -right-[13px] h-12 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600"
    onclick={onClose}
    title="Power / Screen Off"
    aria-label="Power / Screen Off"
  ></button>

  <!-- Volume Buttons -->
  <div class="absolute top-[250px] -right-[13px] flex flex-col gap-2">
    <button
      class="h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(1)}
      disabled={$isBatteryDead}
      title="Volume Up"
      aria-label="Volume Up"
    ></button>
    <button
      class="h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(-1)}
      disabled={$isBatteryDead}
      title="Volume Down"
      aria-label="Volume Down"
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
    class="relative h-full w-full overflow-hidden rounded-[3rem] transition-colors duration-200"
    style={`${!transparent && !$isBatteryDead ? `background: ${wallpaper};` : ''} ${themeStyle}`}
    class:bg-black={$isBatteryDead}
    class:bg-transparent={transparent && !$isBatteryDead}
  >
    <!-- On-Screen Volume HUD Overlay -->
    <VolumeHud />

    <!-- Notification Shade Overlay -->
    <NotificationShade />

    <!-- Dead Phone Screen Overlay -->
    {#if $isBatteryDead}
      <div
        class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black p-6 text-white"
      >
        <!-- Large Blinking Low Battery Icon -->
        <div class="relative flex animate-pulse flex-col items-center justify-center gap-6">
          <!-- Battery Outer Container -->
          <div
            class="relative flex h-14 w-28 items-center justify-start rounded-2xl border-4 border-red-500/80 p-1.5 shadow-[0_0_20px_rgba(239,68,68,0.3)]"
          >
            <!-- Battery Nipple -->
            <div
              class="absolute top-1/2 -right-3.5 h-6 w-2.5 -translate-y-1/2 rounded-r-md bg-red-500/80"
            ></div>
            <!-- Low Battery Red Bar (blinking empty state) -->
            <div class="h-full w-2 rounded-sm bg-red-500"></div>
            <!-- Lightning Cable Warning Icon overlay -->
            <div class="absolute inset-0 flex items-center justify-center">
              <LightningWarningIcon />
            </div>
          </div>
          <div class="flex flex-col items-center gap-1.5 text-center">
            <span class="text-xs font-semibold tracking-wider text-red-400 uppercase"
              >Battery Low</span
            >
            <span class="text-[11px] font-light text-gray-400">Connect Battery Bank</span>
          </div>
        </div>
      </div>
    {/if}

    <!-- Status Bar -->
    {#if !transparent && !$isBatteryDead}
      <button
        type="button"
        class="text-on-surface absolute top-0 z-60 flex w-full cursor-pointer items-center justify-between px-8 pt-3 text-sm font-medium transition-opacity hover:opacity-90 active:opacity-75"
        onclick={() => ($isShadeOpen ? closeShade() : openShade())}
        aria-label={$isShadeOpen ? 'Close notification shade' : 'Open notification shade'}
      >
        <span>{$formattedTime}</span>
        <div class="flex items-center gap-2">
          {#if $bluetoothEnabled}
            <BluetoothIcon class="h-3.5 w-3.5 opacity-90" />
          {/if}
          <SignalIcon level={$clampedSignalLevel} />

          <!-- Battery Status Indicator.

               The fill is a traffic light, so only two thirds of it is themed. Red maps
               to `error`, which is safe because M3's error palette is fixed rather than
               generated from the seed — it is red under every theme. Yellow has no role
               to map to and stays a raw palette class deliberately: `tertiary` *is*
               seeded, so using it here would render "battery getting low" in whatever
               hue the player picked, which is not what a warning color is for. -->
          <div class="flex items-center gap-1.5">
            <span class="text-xs" class:text-error={$displayCharge <= 20}>{$displayCharge}%</span>
            <div
              class="border-on-surface-variant relative flex h-2.5 w-5 items-center justify-start rounded-[3px] border p-[1px]"
            >
              <div
                class="bg-on-surface-variant absolute top-1/2 -right-[3px] h-1 w-[2px] -translate-y-1/2 rounded-r-[1px]"
              ></div>
              <div
                class="h-full rounded-[1px] transition-all duration-300"
                class:bg-error={$displayCharge <= 20}
                class:bg-yellow-400={$displayCharge > 20 && $displayCharge <= 40}
                class:bg-on-surface={$displayCharge > 40}
                style="width: {Math.max(8, $displayCharge)}%;"
              ></div>
            </div>
          </div>
        </div>
      </button>
    {/if}

    <!-- Hole Punch Camera -->
    <div
      class="absolute top-2 left-1/2 z-30 h-6 w-6 -translate-x-1/2 rounded-full bg-black ring-1 ring-gray-800"
    ></div>

    <!-- Content Area -->
    {#if !$isBatteryDead}
      <div class="h-full">
        {@render children()}
      </div>
    {/if}

    <!-- Home Indicator Gesture Bar.

         The label names the one action the press will actually perform, rather than
         listing both. It briefly read "Return to home screen or collapse notifications",
         which is worse on both counts: a screen reader hears a disjunction it has to
         resolve itself, and four e2e specs match this attribute exactly and silently
         stopped finding the button. Same shape as the status bar above. -->
    <button
      class="absolute bottom-0 left-0 z-50 flex h-6 w-full cursor-pointer items-end justify-center pb-1.5"
      onclick={() => {
        if ($isShadeOpen) {
          closeShade();
        } else {
          goHome();
        }
      }}
      aria-label={$isShadeOpen ? 'Collapse notifications' : 'Return to home screen'}
    >
      <div
        class="h-1 w-1/3 rounded-full bg-white/80 transition-colors duration-200 hover:bg-white"
      ></div>
    </button>
  </div>
</div>
