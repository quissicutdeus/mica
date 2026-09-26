<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { formatTime, type WidgetSize } from '@mica/sdk';
  import { SvelteDate } from 'svelte/reactivity';
  import { locale } from '../../../../sdk/i18n';
  import { time, is24Hour } from '../state/time';

  /**
   * The Clock widget (MICA-245): the time and the date, at a `2x1` and a `2x2`.
   *
   * The hours and minutes are the status bar's own (`state/time.ts`), so the two can never
   * disagree — in game that is the game clock, which the NUI's `setTime` writes. The date is
   * the one part the game clock does not carry (hours and minutes alone), so it is the real
   * calendar's, exactly as the shade's date is, formatted under the phone's locale (MICA-61).
   *
   * It draws on its own `surface-container` card rather than on the wallpaper, so the text is
   * always `on-surface` against a token the theme measures and never against a photograph.
   * Nothing here animates, so `reducedMotion` has nothing to switch off.
   */
  let { size }: { size: WidgetSize } = $props();

  const clockText = $derived.by(() => {
    const at = new SvelteDate();
    at.setHours($time.hours, $time.minutes, 0, 0);
    return formatTime(at, $is24Hour);
  });

  // `$time` is in the dependency list so the date rolls over with the clock rather than on
  // a timer of its own; a day changes on a minute boundary like everything else here.
  const dateText = $derived.by(() => {
    void $time;
    return new SvelteDate().toLocaleDateString($locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  });
  const shortDate = $derived.by(() => {
    void $time;
    return new SvelteDate().toLocaleDateString($locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  });
</script>

<div
  data-testid="widget-clock"
  data-size={size}
  class="bg-surface-container text-on-surface flex h-full w-full flex-col justify-center overflow-hidden rounded-box px-4"
>
  {#if size === '2x2'}
    <span class="text-4xl font-light" data-testid="widget-clock-time">{clockText}</span>
    <span class="text-title-medium text-on-surface-variant mt-1" data-testid="widget-clock-date"
      >{dateText}</span
    >
  {:else}
    <span class="text-3xl font-light" data-testid="widget-clock-time">{clockText}</span>
    <span class="text-body-small text-on-surface-variant" data-testid="widget-clock-date"
      >{shortDate}</span
    >
  {/if}
</div>
