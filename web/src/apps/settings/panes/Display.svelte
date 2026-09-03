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
    useDisplayWrite,
    useLocale
  } from '@gos/sdk';
  import { DEVICES } from '@gos/shared/devices';
  import ThemeAndWallpaper from '../components/ThemeAndWallpaper.svelte';

  const { t } = useLocale();

  // Appearance lives on this page rather than behind a row on it. It was briefly its own
  // pane, which put the thing a player most often changes two taps deep for no gain — the
  // sections are groups on one scrollable page, in the order you would set them: light or
  // dark first, since it reframes everything after it, then the color, the presets, a
  // photo, and finally the size and the clock.
  const { is24Hour } = useClock();
  const { setIs24Hour } = useClockWrite();
  const {
    device,
    displaySize,
    displaySizeDefault,
    phoneBox,
    isSizeLimited,
    homeGridColumns,
    homeGridRows,
    motionPreference,
    reducedMotion
  } = useDisplay();
  const { setDisplaySize, setHomeGridSize, setMotionPreference } = useDisplayWrite();

  /**
   * The stepper's bounds are the *active* device's, not the phone's (MICA-261).
   *
   * `useDisplay()` still exposes `homeGridColumnsMin`/`Max` and friends, but those are the
   * phone's constants: on a tablet, whose launcher runs 6-10 columns by 3-5 rows, they
   * would disable the + button three columns before the grid is actually full and let the
   * − button walk the rows below what the frame draws. `DEVICES` is the one table both the
   * launcher and this stepper read, so the two cannot disagree.
   */
  const launcherRanges = $derived(DEVICES[$device].launcher);
  const columnsMin = $derived(launcherRanges.columnRange[0]);
  const columnsMax = $derived(launcherRanges.columnRange[1]);
  const rowsMin = $derived(launcherRanges.rowRange[0]);
  const rowsMax = $derived(launcherRanges.rowRange[1]);

  /**
   * Three states rather than a switch, because "off" and "follow the system" are
   * genuinely different answers and the phone cannot merge them honestly: in game the
   * platform's `prefers-reduced-motion` may never report anything at all (see
   * `shell/state/motion.ts`), so a player who needs the animations gone needs to be able
   * to say so outright rather than hoping CEF passed the setting through.
   */
  const MOTION_OPTIONS = $derived([
    { id: 'system', label: $t('settings.display.motionSystem') },
    { id: 'full', label: $t('settings.display.motionFull') },
    { id: 'reduced', label: $t('settings.display.motionReduced') }
  ]);

  const rendered = $derived(
    $t('settings.display.rendered', {
      width: Math.round($phoneBox.width),
      height: Math.round($phoneBox.height)
    })
  );
</script>

<div class="space-y-6 p-4">
  <ThemeAndWallpaper />

  <SettingsSection title={$t('settings.display.size')} footer={$t('settings.display.sizeFooter')}>
    <div class="flex flex-col gap-3 p-4">
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">{$t('settings.display.phoneSize')}</span>
        <span class="text-on-surface font-mono">{$displaySize}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={$displaySize}
        aria-label={$t('settings.display.phoneSizeLabel')}
        oninput={(e) => setDisplaySize(Number(e.currentTarget.value))}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-box accent-blue-500"
      />
      <div class="text-on-surface-variant text-body-small flex items-center justify-between">
        <span>{$t('settings.display.smaller')}</span>
        <span class="font-mono">{rendered}</span>
        <span>{$t('settings.display.larger')}</span>
      </div>
      <!-- Why the largest setting is smaller here than it would be on a bigger window.
           The slider itself is never dead now — it spans whatever this window can draw,
           so every position moves the phone — but the top of that range is the window's
           to decide, and saying so beats leaving it a mystery. -->
      {#if $isSizeLimited}
        <p class="text-on-surface-variant text-body-small">
          {$t('settings.display.sizeLimited')}
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
        {$t('settings.display.resetDefault')}
      </button>
    </div>
  </SettingsSection>

  <SettingsSection title={$t('settings.display.grid')} footer={$t('settings.display.gridFooter')}>
    <div class="flex flex-col gap-3 px-4 pb-4">
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">{$t('settings.display.columns')}</span>
        <div class="flex items-center gap-3">
          <button
            type="button"
            aria-label={$t('settings.display.fewerColumns')}
            disabled={$homeGridColumns <= columnsMin}
            onclick={() => setHomeGridSize($homeGridColumns - 1, $homeGridRows)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >−</button
          >
          <span class="text-on-surface w-4 text-center font-mono">{$homeGridColumns}</span>
          <button
            type="button"
            aria-label={$t('settings.display.moreColumns')}
            disabled={$homeGridColumns >= columnsMax}
            onclick={() => setHomeGridSize($homeGridColumns + 1, $homeGridRows)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >+</button
          >
        </div>
      </div>
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">{$t('settings.display.rows')}</span>
        <div class="flex items-center gap-3">
          <button
            type="button"
            aria-label={$t('settings.display.fewerRows')}
            disabled={$homeGridRows <= rowsMin}
            onclick={() => setHomeGridSize($homeGridColumns, $homeGridRows - 1)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >−</button
          >
          <span class="text-on-surface w-4 text-center font-mono">{$homeGridRows}</span>
          <button
            type="button"
            aria-label={$t('settings.display.moreRows')}
            disabled={$homeGridRows >= rowsMax}
            onclick={() => setHomeGridSize($homeGridColumns, $homeGridRows + 1)}
            class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
            >+</button
          >
        </div>
      </div>
    </div>
  </SettingsSection>

  <SettingsSection
    title={$t('settings.display.motion')}
    footer={$t('settings.display.motionFooter')}
  >
    <div class="flex flex-col gap-3 p-4">
      <SegmentedControl
        options={MOTION_OPTIONS}
        selected={$motionPreference}
        aria-label={$t('settings.display.motionLabel')}
        onchange={(id: string) => setMotionPreference(id as 'system' | 'full' | 'reduced')}
      />
      <!-- What "System" resolved to, since the query is invisible from inside the phone and
           a player who picks it deserves to know which way it went. -->
      {#if $motionPreference === 'system'}
        <p class="text-on-surface-variant text-body-small">
          {$t('settings.display.motionFollowing', {
            state: $reducedMotion
              ? $t('settings.display.motionOff')
              : $t('settings.display.motionOn')
          })}
        </p>
      {/if}
    </div>
  </SettingsSection>

  <SettingsSection title={$t('settings.display.clock')}>
    <ToggleSwitch
      label={$t('settings.display.time24')}
      description={$t('settings.display.time24Description')}
      checked={$is24Hour}
      onchange={(v: boolean) => setIs24Hour(v)}
    />
  </SettingsSection>
</div>
