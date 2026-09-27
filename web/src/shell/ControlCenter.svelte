<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from './messages';
  import { get } from 'svelte/store';
  import type { Component } from 'svelte';
  import { fade, fly, focusTrap } from '@mica/sdk';
  import * as sdkIcons from '../../../sdk/icons';
  import { attachDragGesture } from '../lib/phone/pointerDrag';
  import { createSheetClose } from '../lib/phone/sheetDrag';
  import AirplaneIcon from '../../../sdk/ui/icons/AirplaneIcon.svelte';
  import BluetoothIcon from '../../../sdk/ui/icons/BluetoothIcon.svelte';
  import CheckIcon from '../../../sdk/ui/icons/CheckIcon.svelte';
  import ChevronLeftIcon from '../../../sdk/ui/icons/ChevronLeftIcon.svelte';
  import ChevronRightIcon from '../../../sdk/ui/icons/ChevronRightIcon.svelte';
  import CloseIcon from '../../../sdk/ui/icons/CloseIcon.svelte';
  import EditIcon from '../../../sdk/ui/icons/EditIcon.svelte';
  import FlashlightIcon from '../../../sdk/ui/icons/FlashlightIcon.svelte';
  import MoonIcon from '../../../sdk/ui/icons/MoonIcon.svelte';
  import SettingsIcon from '../../../sdk/ui/icons/SettingsIcon.svelte';
  import SignalIcon from '../../../sdk/ui/icons/SignalIcon.svelte';
  import NowPlaying from './NowPlaying.svelte';
  import NearbyMusic from './NearbyMusic.svelte';
  import { shadeDragRevealDistance } from './state/display';
  import { setVolume, soundVolume, soundMuted } from './state/audio';
  import {
    brightness,
    BRIGHTNESS_MIN,
    closeControlCenter,
    controlCenterDragPhase,
    controlCenterDragProgress,
    controlCenterLayout,
    isControlCenterOpen,
    moveToggle,
    orderedSections,
    resetControlCenterLayout,
    setToggleHidden,
    visibleSections,
    type ControlCenterToggle
  } from './state/controlCenter';

  /**
   * The control center (MICA-247). `state/controlCenter.ts` carries the reasoning for it being a
   * sheet of its own rather than the shade's second page; this file is the drawing of it.
   */

  type IconComponent = Component<{ class?: string }>;

  const BUILTIN_ICONS: Record<string, IconComponent> = {
    cellular: SignalIcon,
    bluetooth: BluetoothIcon,
    airplane: AirplaneIcon,
    dnd: MoonIcon,
    flashlight: FlashlightIcon
  };

  /** Spelled out for the tooltip and accessible name where the tile label is abbreviated. */
  const labelOf = (toggle: ControlCenterToggle): string => {
    switch (toggle.key) {
      case 'cellular':
        return $t('shell.toggleNetwork');
      case 'bluetooth':
        return $t('shell.toggleBluetooth');
      case 'airplane':
        return $t('shell.toggleAirplane');
      case 'dnd':
        return $t('shell.toggleDnd');
      case 'flashlight':
        return $t('shell.toggleFlashlight');
      default:
        return toggle.label ?? toggle.key;
    }
  };

  const nameOf = (toggle: ControlCenterToggle): string =>
    toggle.key === 'dnd' ? $t('shell.toggleDndName') : labelOf(toggle);

  /**
   * The tile's own label is a `label`/`icon` the *contributing add-on* chose, so nothing
   * stops it picking "Airplane" and an airplane icon and running its own handler behind
   * them (MICA-247 review). The accessible name is not the add-on's to write: it always
   * names the owning app, so a screen reader (and anyone reading the accessible-name
   * tooltip) hears which app it actually is regardless of what the tile claims to be.
   */
  const accessibleNameOf = (toggle: ControlCenterToggle, appName: string | null): string =>
    !toggle.builtin && appName
      ? $t('shell.toggleFromApp', { name: nameOf(toggle), app: appName })
      : nameOf(toggle);

  /**
   * An add-on names its icon by its `@mica/sdk` export (`'MoonIcon'`). A bare name
   * (`'moon'`) is accepted too; an unknown one draws a generic icon rather than breaking
   * the row.
   */
  const iconComponentFor = (toggle: ControlCenterToggle): IconComponent | null => {
    if (toggle.builtin) return BUILTIN_ICONS[toggle.key] ?? null;
    const raw = (toggle.icon ?? '').trim();
    const icons = sdkIcons as Record<string, unknown>;
    const pascal = raw.charAt(0).toUpperCase() + raw.slice(1);
    const found = icons[raw] ?? icons[`${pascal}Icon`];
    return (found as IconComponent | undefined) ?? SettingsIcon;
  };

  let editing = $state(false);
  let sheetElement = $state<HTMLElement | null>(null);
  let scrollRef = $state<HTMLElement | null>(null);

  let shownSections = $derived(editing ? $orderedSections : $visibleSections);

  const closeDrag = createSheetClose({
    direction: 'up',
    progress: controlCenterDragProgress,
    phase: controlCenterDragPhase,
    revealDistance: $shadeDragRevealDistance,
    close: closeControlCenter,
    scrollContainer: () => scrollRef
  });

  $effect(() => {
    if (!sheetElement) return;
    return attachDragGesture(sheetElement, {
      axis: 'y',
      // A slider's own drag is the one gesture here that is not a button.
      shouldStart: (e) =>
        !(e.target as HTMLElement).closest('input') && closeDrag.bodyShouldStart(e),
      onMove: closeDrag.onMove,
      onEnd: closeDrag.onEnd,
      onCancel: closeDrag.abandon
    });
  });

  // Same fallback as the shade: an overshoot drag produces no `transitionend`.
  $effect(() => {
    if ($controlCenterDragPhase !== 'settling') return;
    const timeout = setTimeout(() => {
      if (get(controlCenterDragPhase) === 'settling') controlCenterDragPhase.set('idle');
    }, 250);
    return () => clearTimeout(timeout);
  });

  // Closing the sheet leaves edit mode; reopening should not land mid-edit.
  $effect(() => {
    if (!$isControlCenterOpen && $controlCenterDragPhase === 'idle') editing = false;
  });

  let volumePercent = $derived($soundMuted ? 0 : Math.round($soundVolume * 100));
  let brightnessPercent = $derived(Math.round($brightness * 100));
  const BRIGHTNESS_MIN_PERCENT = Math.round(BRIGHTNESS_MIN * 100);

  const onVolume = (e: Event) =>
    setVolume(Number((e.currentTarget as HTMLInputElement).value) / 100);
  const onBrightness = (e: Event) => {
    const value = Number((e.currentTarget as HTMLInputElement).value) / 100;
    brightness.set(value);
  };
</script>

<!-- Brightness is a dimming layer: the phone had no brightness before this. Always mounted
     (not inside the sheet's `{#if}`) because it must hold while the sheet is closed;
     `pointer-events-none` so it never takes a tap. Below the punch-hole (`z-80`). -->
{#if $brightness < 1}
  <div
    data-testid="brightness-dim"
    class="pointer-events-none absolute inset-0 z-70"
    style="background: rgba(0, 0, 0, {(1 - $brightness).toFixed(3)});"
  ></div>
{/if}

{#if $isControlCenterOpen || $controlCenterDragPhase !== 'idle'}
  {@const effectiveProgress =
    $controlCenterDragPhase === 'idle'
      ? $isControlCenterOpen
        ? 1
        : 0
      : $controlCenterDragProgress}
  <div
    transition:fade={{ duration: 200 }}
    class="bg-scrim absolute inset-0 z-40 backdrop-blur-sm"
    onclick={closeControlCenter}
    role="presentation"
  ></div>

  <div
    bind:this={sheetElement}
    data-testid="control-center"
    transition:fly={{
      y: -$shadeDragRevealDistance,
      duration: $controlCenterDragPhase === 'idle' ? 300 : 0
    }}
    class="bg-surface-container-high text-on-surface shadow-elevation-5 absolute inset-0 z-55 flex h-full w-full flex-col pt-14 pb-2 backdrop-blur-3xl {$controlCenterDragPhase ===
    'settling'
      ? 'duration-medium ease-emphasized transition-transform'
      : ''}"
    style="transform: translateY({(1 - effectiveProgress) * -$shadeDragRevealDistance}px)"
    ontransitionend={(e) => {
      if (
        e.target === e.currentTarget &&
        e.propertyName === 'transform' &&
        $controlCenterDragPhase === 'settling'
      ) {
        controlCenterDragPhase.set('idle');
      }
    }}
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label={$t('shell.controlCenter')}
  >
    <div class="mb-4 flex items-center justify-between px-6">
      <h2 class="text-on-surface text-lg font-bold tracking-tight">{$t('shell.controlCenter')}</h2>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="control-center-edit"
          class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-primary duration-short ease-standard rounded-full p-2 transition-colors"
          onclick={() => (editing = !editing)}
          title={editing ? $t('shell.controlCenterDone') : $t('shell.controlCenterEdit')}
          aria-label={editing ? $t('shell.controlCenterDone') : $t('shell.controlCenterEdit')}
          aria-pressed={editing}
        >
          {#if editing}
            <CheckIcon class="size-icon-sm" />
          {:else}
            <EditIcon class="size-icon-sm" />
          {/if}
        </button>
        <button
          type="button"
          class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard rounded-full p-2 transition-colors"
          onclick={closeControlCenter}
          title={$t('shell.close')}
          aria-label={$t('shell.closeControlCenter')}
        >
          <CloseIcon class="size-icon-sm" />
        </button>
      </div>
    </div>

    <div bind:this={scrollRef} class="min-h-0 flex-1 scrollbar-none overflow-y-auto px-5 pb-8">
      <!-- Toggles, grouped into a section per contributing app so an add-on can never
           pass one of its toggles off as a built-in switch (MICA-247 review): reorder
           and hide stay scoped to `moveToggle`'s own group, and the grid below never
           mixes a section's rows with another's. -->
      <div data-testid="control-center-toggles">
        {#each shownSections as section (section.appId ?? '__builtin__')}
          <!-- Always headed, the built-ins included (MICA-247 review): if only an
               add-on's section carried a header, the built-ins' headerless section
               would read as "the one true system section" and give a spoofed add-on
               section something to imitate by omission. -->
          <div
            data-testid="control-center-section-{section.appId ?? '__builtin__'}"
            class="text-label-small text-on-surface-variant mb-1 px-1 uppercase"
          >
            {section.appName ?? $t('shell.controlCenterBuiltins')}
          </div>
          <div class="mb-4 grid grid-cols-3 gap-2 px-1">
            {#each section.toggles as toggle (toggle.key)}
              {@const Icon = iconComponentFor(toggle)}
              {@const hidden = $controlCenterLayout.hidden.includes(toggle.key)}
              <div class="flex flex-col gap-1 {hidden ? 'opacity-40' : ''}">
                <button
                  type="button"
                  data-testid="cc-toggle-{toggle.key}"
                  class="duration-short ease-standard flex flex-col items-center gap-1 rounded-box p-3 transition-colors disabled:cursor-not-allowed disabled:opacity-40 {toggle.active
                    ? 'bg-primary-container text-on-primary-container'
                    : 'bg-surface text-on-surface-variant hover:bg-surface-container'}"
                  onclick={toggle.onToggle}
                  disabled={toggle.disabled || editing}
                  title={accessibleNameOf(toggle, section.appName)}
                  aria-label={accessibleNameOf(toggle, section.appName)}
                  aria-pressed={toggle.active}
                >
                  {#if Icon}
                    <Icon class="size-icon-sm" />
                  {/if}
                  <span class="text-label-small max-w-full truncate">{labelOf(toggle)}</span>
                </button>
                {#if editing}
                  <div class="flex items-center justify-between gap-1">
                    <button
                      type="button"
                      class="bg-surface text-on-surface-variant rounded-full p-1 disabled:opacity-40"
                      onclick={() => moveToggle(toggle.key, -1)}
                      disabled={section.toggles[0]?.key === toggle.key}
                      aria-label={$t('shell.moveToggleEarlier', { name: nameOf(toggle) })}
                    >
                      <ChevronLeftIcon class="size-icon-sm" />
                    </button>
                    <button
                      type="button"
                      class="bg-surface text-on-surface-variant text-label-small rounded-full px-2 py-1"
                      onclick={() => setToggleHidden(toggle.key, !hidden)}
                      aria-pressed={hidden}
                      aria-label={hidden
                        ? $t('shell.showToggle', { name: nameOf(toggle) })
                        : $t('shell.hideToggle', { name: nameOf(toggle) })}
                    >
                      {hidden ? $t('shell.showToggleShort') : $t('shell.hideToggleShort')}
                    </button>
                    <button
                      type="button"
                      class="bg-surface text-on-surface-variant rounded-full p-1 disabled:opacity-40"
                      onclick={() => moveToggle(toggle.key, 1)}
                      disabled={section.toggles[section.toggles.length - 1]?.key === toggle.key}
                      aria-label={$t('shell.moveToggleLater', { name: nameOf(toggle) })}
                    >
                      <ChevronRightIcon class="size-icon-sm" />
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>

      {#if editing}
        <button
          type="button"
          class="bg-surface text-on-surface-variant text-label-small mb-4 rounded-full px-3 py-1.5"
          onclick={resetControlCenterLayout}
        >
          {$t('shell.controlCenterReset')}
        </button>
      {/if}

      <!-- Sliders -->
      <div class="mb-4 flex flex-col gap-3 px-1">
        <label class="bg-surface flex flex-col gap-1 rounded-box p-3">
          <span class="text-label-small text-on-surface-variant flex justify-between">
            <span>{$t('shell.brightness')}</span>
            <span>{brightnessPercent}%</span>
          </span>
          <input
            type="range"
            data-testid="cc-brightness"
            class="accent-primary w-full"
            min={BRIGHTNESS_MIN_PERCENT}
            max="100"
            step="1"
            value={brightnessPercent}
            oninput={onBrightness}
          />
        </label>
        <label class="bg-surface flex flex-col gap-1 rounded-box p-3">
          <span class="text-label-small text-on-surface-variant flex justify-between">
            <span>{$t('shell.volume')}</span>
            <span data-testid="cc-volume-percent">{volumePercent}%</span>
          </span>
          <input
            type="range"
            data-testid="cc-volume"
            class="accent-primary w-full"
            min="0"
            max="100"
            step="1"
            value={volumePercent}
            oninput={onVolume}
          />
        </label>
      </div>

      <!-- The music tray: the same two components the shade carries. Both render nothing
           when there is nothing to show. -->
      <NowPlaying />
      <NearbyMusic />
    </div>
  </div>
{/if}
