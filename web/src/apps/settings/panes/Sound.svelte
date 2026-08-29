<script lang="ts">
  /**
   * Sound, which is two channels and not one. MICA-111 phase 4.
   *
   * The phone has always had a system volume — clicks, the ringtone, the notification
   * chime — and music has had a level of its own since the player landed
   * (`shell/state/music.ts` says why turning one down must not silence the other). What
   * was missing was any way to reach the music one from here: it lived on a slider inside
   * the Music app, which is the wrong place for it twice over. Music keeps playing with
   * the phone closed and the app backgrounded, so the moment somebody most wants the
   * volume is the moment they are furthest from that screen — and a person who wants
   * "turn the sound down" goes to Settings > Sound, not to the app making the noise.
   *
   * Music is drawn second because the system channel is the one that governs the phone
   * itself; that ordering is the only thing the position means.
   */
  import { SettingsSection, ToggleSwitch, useSystemHardware, useMusic } from '@gphone/sdk';

  const {
    soundVolume,
    soundMuted,
    setVolume,
    toggleMute,
    volumeStep,
    setVolumeStep,
    volumeStepChoices
  } = useSystemHardware();

  const { musicVolume, musicMuted, setMusicVolume, toggleMusicMute } = useMusic();
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
        oninput={(e) => setVolume(Number(e.currentTarget.value) / 100)}
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

  <!-- Music's own channel. Reaches this phone's track and every nearby broadcast, because
       both are fed from `musicOutputVolume` and nothing else. -->
  <SettingsSection title="Music">
    <div class="flex flex-col gap-3 p-4">
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">Music Volume</span>
        <span class="text-on-surface font-mono">
          {$musicMuted ? 'Muted' : `${Math.round($musicVolume * 100)}%`}
        </span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={Math.round($musicVolume * 100)}
        aria-label="Music volume"
        oninput={(e) => setMusicVolume(Number(e.currentTarget.value) / 100)}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-blue-500"
      />
    </div>
    <div class="border-outline-variant border-t">
      <ToggleSwitch
        label="Mute Music"
        description="Silence music without stopping it, yours and anyone nearby"
        checked={$musicMuted}
        onchange={toggleMusicMute}
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
