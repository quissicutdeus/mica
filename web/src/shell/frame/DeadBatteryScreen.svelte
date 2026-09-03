<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from '../messages';
  import LightningWarningIcon from '../../../../sdk/ui/icons/LightningWarningIcon.svelte';

  /**
   * The dead-battery takeover, out of `PhoneFrame.svelte` so the tablet's frame draws the
   * same one (MICA-259). There is one charge store until MICA-264 gives the tablet its
   * own identity, so a flat phone is a flat tablet; the overlay is the honest picture of
   * that rather than a tablet that keeps working on a battery the phone says is empty.
   */
</script>

<div
  class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black p-6 text-white"
>
  <!-- Large Blinking Low Battery Icon -->
  <div class="relative flex animate-pulse flex-col items-center justify-center gap-6">
    <!-- Battery Outer Container -->
    <div
      class="relative flex h-14 w-28 items-center justify-start rounded-box border-4 border-red-500/80 p-1.5 shadow-[0_0_20px_rgba(239,68,68,0.3)]"
    >
      <!-- Battery Nipple -->
      <div
        class="absolute top-1/2 -right-3.5 h-6 w-2.5 -translate-y-1/2 rounded-r-md bg-red-500/80"
      ></div>
      <!-- Low Battery Red Bar (blinking empty state) -->
      <div class="h-full w-2 rounded-chip bg-red-500"></div>
      <!-- Lightning Cable Warning Icon overlay -->
      <div class="absolute inset-0 flex items-center justify-center">
        <LightningWarningIcon />
      </div>
    </div>
    <div class="flex flex-col items-center gap-1.5 text-center">
      <span class="text-body-small tracking-wider text-red-400 uppercase"
        >{$t('shell.batteryLow')}</span
      >
      <span class="text-[11px] font-light text-gray-400">{$t('shell.connectBatteryBank')}</span>
    </div>
  </div>
</div>
