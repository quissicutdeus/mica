<script lang="ts">
  import { SettingsSection, ToggleSwitch, useSystemHardware } from '@gphone/sdk';

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
  <SettingsSection title="Volume">
    <div class="flex flex-col gap-3 p-4">
      <div class="text-body-medium flex items-center justify-between">
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
  </SettingsSection>

  <!-- How far the physical buttons on the side of the phone move the volume per press. -->
  <SettingsSection title="Volume Buttons">
    <div class="px-4 pb-4">
      <div class="text-body-medium mb-3 flex items-center justify-between">
        <span class="text-on-surface font-medium">Step Size</span>
        <span class="text-on-surface font-mono">{$volumeStep}%</span>
      </div>
      <div class="grid grid-cols-5 gap-1.5">
        {#each volumeStepChoices as choice (choice)}
          <button
            type="button"
            onclick={() => setVolumeStep(choice)}
            aria-pressed={$volumeStep === choice}
            class="text-body-small cursor-pointer rounded border py-1.5 transition-all {$volumeStep ===
            choice
              ? 'border-primary bg-primary-container text-on-primary-container'
              : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high'} duration-short ease-standard"
          >
            {choice}%
          </button>
        {/each}
      </div>
      <p class="text-on-surface-variant text-body-small mt-3">
        How much each press of the volume buttons on the side of the phone changes the volume.
      </p>
    </div>
  </SettingsSection>
</div>
