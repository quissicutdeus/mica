<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { useLocale } from '@mica/sdk';

  /**
   * What can be done about a match, from its thread: see their profile, unmatch, block, report.
   * A menu by the control that opened it, as Glimpse's account menu is, rather than a sheet.
   */
  let {
    onprofile,
    onunmatch,
    onblock,
    onreport,
    onclose
  }: {
    onprofile: () => void;
    onunmatch: () => void;
    onblock: () => void;
    onreport: () => void;
    onclose: () => void;
  } = $props();

  const { t } = useLocale();
</script>

<!-- A sibling rather than a wrapper: a full-bleed `<button>` cannot contain the panel's own
     buttons, and dimming without catching the click leaves a menu only Back can dismiss. -->
<button
  type="button"
  class="bg-scrim animate-in fade-in duration-short ease-standard absolute inset-0 z-40"
  aria-label={$t('spark.closeMenu')}
  onclick={onclose}
></button>

<!-- `top-20` clears the header, as Glimpse's menu does. -->
<div
  class="animate-in fade-in border-outline-variant bg-surface shadow-elevation-4 duration-short ease-standard absolute top-20 right-2 z-40 w-56 overflow-hidden rounded-box border"
  data-testid="spark-match-menu"
>
  <button
    type="button"
    class="text-on-surface hover:bg-surface-container duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
    onclick={onprofile}
    data-testid="spark-view-profile"
  >
    {$t('spark.viewProfile')}
  </button>
  <button
    type="button"
    class="text-on-surface hover:bg-surface-container duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
    onclick={onunmatch}
    data-testid="spark-unmatch"
  >
    {$t('spark.unmatch')}
  </button>
  <button
    type="button"
    class="text-error hover:bg-surface-container duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
    onclick={onblock}
    data-testid="spark-block"
  >
    {$t('spark.block')}
  </button>
  <button
    type="button"
    class="text-error hover:bg-surface-container duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
    onclick={onreport}
    data-testid="spark-report-profile"
  >
    {$t('spark.report')}
  </button>
</div>
