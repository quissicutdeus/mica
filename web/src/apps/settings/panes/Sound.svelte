<script lang="ts">
  import { ToggleSwitch, useSystemHardware } from '@gphone/sdk';

  const {
    soundVolume,
    soundMuted,
    setVolume,
    toggleMute,
    volumeStep,
    setVolumeStep,
    volumeStepChoices
  } = useSystemHardware();
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">Volume</h2>
    <div class="overflow-hidden rounded-xl bg-gray-800">
      <div class="flex flex-col gap-3 p-4">
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium text-gray-200">System Volume</span>
          <span class="font-mono text-gray-300">
            {$soundMuted ? 'Muted' : `${Math.round($soundVolume * 100)}%`}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round($soundVolume * 100)}
          aria-label="System volume"
          oninput={(e) => setVolume(Number((e.currentTarget as HTMLInputElement).value) / 100)}
          class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-gray-900 accent-blue-500"
        />
      </div>
      <div class="border-t border-gray-700">
        <ToggleSwitch
          label="Mute"
          description="Silence all phone sounds"
          checked={$soundMuted}
          onchange={toggleMute}
        />
      </div>
    </div>
  </div>

  <div>
    <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">
      Volume Buttons
    </h2>
    <!-- How far the physical buttons on the side of the phone move the volume per press. -->
    <div class="overflow-hidden rounded-xl bg-gray-800 p-4">
      <div class="mb-3 flex items-center justify-between text-sm">
        <span class="font-medium text-gray-200">Step Size</span>
        <span class="font-mono text-gray-300">{$volumeStep}%</span>
      </div>
      <div class="grid grid-cols-5 gap-1.5">
        {#each volumeStepChoices as choice (choice)}
          <button
            type="button"
            onclick={() => setVolumeStep(choice)}
            aria-pressed={$volumeStep === choice}
            class="cursor-pointer rounded border py-1.5 text-xs font-semibold transition-all {$volumeStep ===
            choice
              ? 'border-blue-500 bg-blue-600 text-white'
              : 'border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-700'}"
          >
            {choice}%
          </button>
        {/each}
      </div>
      <p class="mt-3 text-xs text-gray-500">
        How much each press of the volume buttons on the side of the phone changes the volume.
      </p>
    </div>
  </div>
</div>
