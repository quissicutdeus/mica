<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { formattedTime } from '../store/time';
  import { goHome } from '../store/navigation';
  import { displayCharge, isDead } from '../store/charge';
  import { clampedSignalLevel } from '../store/signal';
  import { stepVolume } from '../store/sound';
  import { enableDragScroll } from '../utils/dragScroll';
  import LightningWarningIcon from './icons/LightningWarningIcon.svelte';
  import SignalIcon from './icons/SignalIcon.svelte';
  import VolumeHud from './VolumeHud.svelte';

  let { transparent = false, onClose, children } = $props();
  let screenElement = $state<HTMLElement | null>(null);

  onMount(() => {
    if (screenElement) {
      return enableDragScroll(screenElement);
    }
  });
</script>

<!-- Phone Frame -->
<div
  transition:fly={{ y: 1000, duration: 500 }}
  class="relative h-[850px] w-[400px] rounded-[3.5rem] border-[8px] border-gray-950 bg-gray-950 shadow-2xl ring-1 ring-gray-600 transition-colors duration-200"
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
      class="h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600"
      onclick={() => stepVolume(1)}
      title="Volume Up"
      aria-label="Volume Up"
    ></button>
    <button
      class="h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600"
      onclick={() => stepVolume(-1)}
      title="Volume Down"
      aria-label="Volume Down"
    ></button>
  </div>

  <!-- Screen -->
  <div
    bind:this={screenElement}
    class="relative h-full w-full overflow-hidden rounded-[3rem] transition-colors duration-200"
    class:bg-gray-900={!transparent && !$isDead}
    class:bg-black={$isDead}
    class:bg-transparent={transparent && !$isDead}
  >
    <!-- On-Screen Volume HUD Overlay -->
    <VolumeHud />

    <!-- Dead Phone Screen Overlay -->
    {#if $isDead}
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
    {#if !transparent && !$isDead}
      <div
        class="absolute top-0 z-20 flex w-full items-center justify-between px-8 pt-3 text-sm font-medium text-white"
      >
        <span>{$formattedTime}</span>
        <div class="flex items-center gap-2">
          <SignalIcon level={$clampedSignalLevel} />

          <!-- Battery Status Indicator -->
          <div class="flex items-center gap-1.5">
            <span class="text-xs" class:text-red-400={$displayCharge <= 20}>{$displayCharge}%</span>
            <div
              class="relative flex h-2.5 w-5 items-center justify-start rounded-[3px] border border-white/80 p-[1px]"
            >
              <div
                class="absolute top-1/2 -right-[3px] h-1 w-[2px] -translate-y-1/2 rounded-r-[1px] bg-white/80"
              ></div>
              <div
                class="h-full rounded-[1px] transition-all duration-300"
                class:bg-red-500={$displayCharge <= 20}
                class:bg-yellow-400={$displayCharge > 20 && $displayCharge <= 40}
                class:bg-white={$displayCharge > 40}
                style="width: {Math.max(8, $displayCharge)}%;"
              ></div>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Hole Punch Camera -->
    <div
      class="absolute top-2 left-1/2 z-30 h-6 w-6 -translate-x-1/2 rounded-full bg-black ring-1 ring-gray-800"
    ></div>

    <!-- Content Area -->
    {#if !$isDead}
      <div class="h-full" class:pt-8={!transparent} class:pb-4={!transparent}>
        {@render children()}
      </div>
    {/if}

    <!-- Home Indicator Gesture Bar -->
    <button
      class="absolute bottom-0 left-0 z-50 flex h-8 w-full cursor-pointer items-end justify-center pb-2"
      onclick={goHome}
      aria-label="Return to home screen"
    >
      <div
        class="h-1 w-1/3 rounded-full bg-white/80 transition-colors duration-200 hover:bg-white"
      ></div>
    </button>
  </div>
</div>
