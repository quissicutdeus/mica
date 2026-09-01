<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

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
   * Music is drawn after the system channel because the system channel is the one that
   * governs the phone itself; that ordering is the only thing the position means.
   *
   * MICA-62 put the ringer above both, for the same kind of reason. A volume is a level
   * and the ringer is a switch, and "make it stop before this scene starts" is what
   * somebody opens this pane to do — which, until now, they could only do by dragging the
   * system level to zero, taking the clicks, the camera and every notification with it.
   * `shell/state/audio.ts` says where the mode actually reaches, and is honest in the
   * Vibrate row's own description about the one thing it cannot do here.
   */
  import {
    SettingsSection,
    ToggleSwitch,
    useSystemHardware,
    useSystemHardwareWrite,
    useMusic
  } from '@gphone/sdk';

  const {
    soundVolume,
    soundMuted,
    volumeStep,
    volumeStepChoices,
    ringMode,
    ringModeChoices,
    ringtone,
    ringtoneChoices
  } = useSystemHardware();
  const { setVolume, toggleMute, setVolumeStep, setRingMode, setRingtone, previewRingtone } =
    useSystemHardwareWrite();

  /**
   * Choosing a tone plays it, rather than putting a second speaker button beside every
   * row. One control: you cannot pick a ringtone you have not heard, and you cannot hear
   * one without it becoming yours, which is how every handset does this and is one fewer
   * thing to explain.
   */
  const chooseRingtone = (id: (typeof $ringtoneChoices)[number]['id']) => {
    setRingtone(id);
    previewRingtone(id);
  };

  const { musicVolume, musicMuted, setMusicVolume, toggleMusicMute } = useMusic();
</script>

<div class="space-y-6 p-4">
  <!-- The ringer switch. Silent suppresses the ring, the chime and the message pop, and
       nothing else: the call banner still arrives with the only Accept button there is. -->
  <SettingsSection title="Ringer">
    <div class="p-4">
      <div class="grid grid-cols-3 gap-1.5">
        {#each $ringModeChoices as choice (choice.id)}
          <button
            type="button"
            onclick={() => setRingMode(choice.id)}
            aria-pressed={$ringMode === choice.id}
            class="text-body-small cursor-pointer rounded-chip border py-1.5 transition-all {$ringMode ===
            choice.id
              ? 'border-primary bg-primary-container text-on-primary-container'
              : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high'} duration-short ease-standard"
          >
            {choice.label}
          </button>
        {/each}
      </div>
      <p class="text-on-surface-variant text-body-small mt-3">
        {$ringModeChoices.find((choice) => choice.id === $ringMode)?.description ?? ''}
      </p>
    </div>
  </SettingsSection>

  <!-- Every tone is synthesized in `shell/state/audio.ts`, so the list costs the resource
       nothing to download and choosing one is instant. -->
  <SettingsSection title="Ringtone">
    <div class="p-4">
      <div class="flex flex-col gap-1.5">
        {#each $ringtoneChoices as choice (choice.id)}
          <button
            type="button"
            onclick={() => chooseRingtone(choice.id)}
            aria-pressed={$ringtone === choice.id}
            class="text-body-small w-full cursor-pointer rounded-chip border px-3 py-1.5 text-left transition-all {$ringtone ===
            choice.id
              ? 'border-primary bg-primary-container text-on-primary-container'
              : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high'} duration-short ease-standard"
          >
            {choice.label}
          </button>
        {/each}
      </div>
      <p class="text-on-surface-variant text-body-small mt-3">
        Tap a tone to choose it and hear it. A preview plays on silent — you asked for it.
      </p>
    </div>
  </SettingsSection>

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
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-box accent-blue-500"
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
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-box accent-blue-500"
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
            class="text-body-small cursor-pointer rounded-chip border py-1.5 transition-all {$volumeStep ===
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
