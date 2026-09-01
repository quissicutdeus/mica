<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    SegmentedControl,
    SettingsSection,
    ToggleSwitch,
    useClock,
    useClockWrite,
    useDisplay,
    useDisplayWrite
  } from '@gphone/sdk';
  import ThemeAndWallpaper from '../components/ThemeAndWallpaper.svelte';

  // Appearance lives on this page rather than behind a row on it. It was briefly its own
  // pane, which put the thing a player most often changes two taps deep for no gain — the
  // sections are groups on one scrollable page, in the order you would set them: light or
  // dark first, since it reframes everything after it, then the color, the presets, a
  // photo, and finally the size and the clock.
  const { is24Hour } = useClock();
  const { setIs24Hour } = useClockWrite();
  const {
    displaySize,
    displaySizeDefault,
    phoneBox,
    isSizeLimited,
    homeGridColumns,
    homeGridRows,
    homeGridColumnsMin,
    homeGridColumnsMax,
    homeGridRowsMin,
    homeGridRowsMax,
    motionPreference,
    reducedMotion
  } = useDisplay();
  const { setDisplaySize, setHomeGridSize, setMotionPreference } = useDisplayWrite();

  /**
   * Three states rather than a switch, because "off" and "follow the system" are
   * genuinely different answers and the phone cannot merge them honestly: in game the
   * platform's `prefers-reduced-motion` may never report anything at all (see
   * `shell/state/motion.ts`), so a player who needs the animations gone needs to be able
   * to say so outright rather than hoping CEF passed the setting through.
   */
  const MOTION_OPTIONS = [
    { id: 'system', label: 'System' },
    { id: 'full', label: 'Full' },
    { id: 'reduced', label: 'Reduced' }
  ];

  const rendered = $derived(
    `${Math.round($phoneBox.width)} × ${Math.round($phoneBox.height)} pixels`
  );
</script>

<div class="space-y-6 p-4">
  <ThemeAndWallpaper />

  <SettingsSection
    title="Size"
    footer="The phone always keeps its shape; this changes how large it is drawn on screen."
  >
    <div class="flex flex-col gap-3 p-4">
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">Phone Size</span>
        <span class="text-on-surface font-mono">{$displaySize}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={$displaySize}
        aria-label="Phone size"
        oninput={(e) => setDisplaySize(Number(e.currentTarget.value))}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-box accent-blue-500"
      />
      <div class="text-on-surface-variant text-body-small flex items-center justify-between">
        <span>Smaller</span>
        <span class="font-mono">{rendered}</span>
        <span>Larger</span>
      </div>
      <!-- Why the largest setting is smaller here than it would be on a bigger window.
           The slider itself is never dead now — it spans whatever this window can draw,
           so every position moves the phone — but the top of that range is the window's
           to decide, and saying so beats leaving it a mystery. -->
      {#if $isSizeLimited}
        <p class="text-on-surface-variant text-body-small">
          This window sets how large the phone can go. Make it taller for more range.
        </p>
      {/if}
    </div>
    <div class="border-outline-variant border-t p-4">
      <button
        type="button"
        onclick={() => setDisplaySize(displaySizeDefault)}
        disabled={$displaySize === displaySizeDefault}
        class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high disabled:hover:bg-surface duration-short ease-standard text-body-small w-full cursor-pointer rounded-box border py-2 transition-colors disabled:cursor-default disabled:opacity-40"
      >
        Reset to Default
      </button>
    </div>
  </SettingsSection>

  <SettingsSection
    title="Home Screen Grid"
    footer="Shrinking the grid moves anything it no longer fits to the next open space, rather than hiding it."
  >
    <div class="flex flex-col gap-3 px-4 pb-4">
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">Columns</span>
        <div class="flex items-center gap-3">
          <button
            type="button"
            aria-label="Fewer columns"
            disabled={$homeGridColumns <= homeGridColumnsMin}
            onclick={() => setHomeGridSize($homeGridColumns - 1, $homeGridRows)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >−</button
          >
          <span class="text-on-surface w-4 text-center font-mono">{$homeGridColumns}</span>
          <button
            type="button"
            aria-label="More columns"
            disabled={$homeGridColumns >= homeGridColumnsMax}
            onclick={() => setHomeGridSize($homeGridColumns + 1, $homeGridRows)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >+</button
          >
        </div>
      </div>
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">Rows</span>
        <div class="flex items-center gap-3">
          <button
            type="button"
            aria-label="Fewer rows"
            disabled={$homeGridRows <= homeGridRowsMin}
            onclick={() => setHomeGridSize($homeGridColumns, $homeGridRows - 1)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >−</button
          >
          <span class="text-on-surface w-4 text-center font-mono">{$homeGridRows}</span>
          <button
            type="button"
            aria-label="More rows"
            disabled={$homeGridRows >= homeGridRowsMax}
            onclick={() => setHomeGridSize($homeGridColumns, $homeGridRows + 1)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >+</button
          >
        </div>
      </div>
    </div>
  </SettingsSection>

  <SettingsSection
    title="Motion"
    footer="Reduced motion turns off the phone's animations. Swipes and drags still work — only the animation goes."
  >
    <div class="flex flex-col gap-3 p-4">
      <SegmentedControl
        options={MOTION_OPTIONS}
        selected={$motionPreference}
        aria-label="Motion"
        onchange={(id: string) => setMotionPreference(id as 'system' | 'full' | 'reduced')}
      />
      <!-- What "System" resolved to, since the query is invisible from inside the phone and
           a player who picks it deserves to know which way it went. -->
      {#if $motionPreference === 'system'}
        <p class="text-on-surface-variant text-body-small">
          Following this device: animations are {$reducedMotion ? 'off' : 'on'}.
        </p>
      {/if}
    </div>
  </SettingsSection>

  <SettingsSection title="Clock">
    <ToggleSwitch
      label="24-Hour Time"
      description="Use 24-hour format"
      checked={$is24Hour}
      onchange={(v: boolean) => setIs24Hour(v)}
    />
  </SettingsSection>
</div>
