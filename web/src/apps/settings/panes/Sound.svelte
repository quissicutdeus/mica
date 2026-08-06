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
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Volume
    </h2>
    <div class="bg-surface-container overflow-hidden rounded-xl">
      <div class="flex flex-col gap-3 p-4">
        <div class="flex items-center justify-between text-sm">
          <span class="text-on-surface font-medium">System Volume</span>
          <span class="text-on-surface font-mono">
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
          class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-blue-500"
        />
      </div>
      <div class="border-outline-variant border-t">
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
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Volume Buttons
    </h2>
    <!-- How far the physical buttons on the side of the phone move the volume per press. -->
    <div class="bg-surface-container overflow-hidden rounded-xl p-4">
      <div class="mb-3 flex items-center justify-between text-sm">
        <span class="text-on-surface font-medium">Step Size</span>
        <span class="text-on-surface font-mono">{$volumeStep}%</span>
      </div>
      <div class="grid grid-cols-5 gap-1.5">
        {#each volumeStepChoices as choice (choice)}
          <button
            type="button"
            onclick={() => setVolumeStep(choice)}
            aria-pressed={$volumeStep === choice}
            class="cursor-pointer rounded border py-1.5 text-xs font-semibold transition-all {$volumeStep ===
            choice
              ? 'border-primary bg-primary text-on-primary'
              : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high'}"
          >
            {choice}%
          </button>
        {/each}
      </div>
      <p class="text-on-surface-variant mt-3 text-xs">
        How much each press of the volume buttons on the side of the phone changes the volume.
      </p>
    </div>
  </div>
</div>
