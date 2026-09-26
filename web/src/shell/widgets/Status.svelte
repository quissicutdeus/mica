<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { WidgetSize } from '@mica/sdk';
  import BatteryIcon from '../../../../sdk/ui/icons/BatteryIcon.svelte';
  import SignalIcon from '../../../../sdk/ui/icons/SignalIcon.svelte';
  import AirplaneIcon from '../../../../sdk/ui/icons/AirplaneIcon.svelte';
  import { t } from '../messages';
  import { displayCharge } from '../state/charge';
  import { clampedSignalLevel } from '../state/signal';
  import { airplaneModeEnabled } from '../state/airplane';

  /**
   * The Status widget (MICA-245): battery and signal, from the stores the status bar reads,
   * so the two never disagree.
   *
   * There is no "charging" state here on purpose. The web side has none to read — the
   * client's charging flag was removed when the drain moved server-side (see the note in
   * `state/charge.ts`) — and a glyph invented from a level that happened to rise would be
   * wrong as often as right.
   *
   * Low is `<= 20`, the status bar's own threshold, and shows in `text-error` rather than
   * a dimmed colour. Every run of text sits on the widget's own `surface-container`, so it
   * is a measured token pair and never text on a photograph. Nothing animates.
   */
  let { size }: { size: WidgetSize } = $props();

  const low = $derived($displayCharge <= 20);
  const signalLabel = $derived(
    $airplaneModeEnabled
      ? $t('shell.widget.airplane')
      : $clampedSignalLevel === 0
        ? $t('shell.widget.noSignal')
        : $t('shell.widget.signal', { bars: $clampedSignalLevel })
  );
  const batteryLabel = $derived($t('shell.widget.battery', { percent: $displayCharge }));
</script>

<div
  data-testid="widget-status"
  data-size={size}
  role="group"
  aria-label={$t('shell.widget.status')}
  class="bg-surface-container text-on-surface flex h-full w-full overflow-hidden rounded-box px-4 {size ===
  '2x2'
    ? 'flex-col justify-center gap-4'
    : 'flex-row items-center justify-between'}"
>
  <div class="flex items-center gap-3" role="img" aria-label={batteryLabel}>
    <BatteryIcon class="h-4 w-8 shrink-0" charge={$displayCharge} />
    <span
      class={size === '2x2' ? 'text-3xl font-light' : 'text-title-large'}
      class:text-error={low}
      data-testid="widget-status-battery">{$displayCharge}%</span
    >
  </div>
  <div class="flex items-center gap-3" role="img" aria-label={signalLabel}>
    {#if $airplaneModeEnabled}
      <AirplaneIcon class="h-6 w-6 shrink-0" />
    {:else}
      <SignalIcon class="h-6 w-6 shrink-0" level={$clampedSignalLevel} />
    {/if}
    {#if size === '2x2'}
      <span class="text-body-large text-on-surface-variant" data-testid="widget-status-signal"
        >{signalLabel}</span
      >
    {/if}
  </div>
</div>
