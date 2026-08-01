<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { soundVolumePercent, soundMuted, volumeHudVisible } from '../store/sound';
</script>

{#if $volumeHudVisible}
  <div
    transition:fly={{ y: -20, duration: 200 }}
    class="pointer-events-none absolute top-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-white/15 bg-black/80 px-4 py-2 text-white shadow-2xl backdrop-blur-lg select-none"
  >
    <!-- Speaker Icon -->
    {#if $soundMuted || $soundVolumePercent === 0}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-red-400"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z"
          clip-rule="evenodd"
        />
      </svg>
    {:else}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-white/90"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z"
          clip-rule="evenodd"
        />
      </svg>
    {/if}

    <!-- Progress bar -->
    <div class="flex h-1.5 w-20 items-center overflow-hidden rounded-full bg-white/20">
      <div
        class="h-full rounded-full bg-white transition-all duration-150"
        style="width: {$soundVolumePercent}%;"
      ></div>
    </div>

    <span
      data-testid="volume-hud-percent"
      class="min-w-[28px] text-xs font-semibold tracking-wider text-white/90"
    >
      {$soundVolumePercent}%
    </span>
  </div>
{/if}
