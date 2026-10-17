<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { useLocale } from '@mica/sdk';
  import { isImage } from './labels';

  interface Props {
    /** Captured when the report was filed, so it still says what was reported. */
    preview?: string;
    /** The reporter's own words, if they left any. */
    note?: string;
    /**
     * What the reporter goes by where the content was — their alias in a Dark Chat channel
     * (MICA-254). Written by the server, never the payload; absent for most services.
     */
    reporterLabel?: string | null;
  }

  let { preview, note, reporterLabel }: Props = $props();

  const { t } = useLocale();
</script>

{#if isImage(preview)}
  <img src={preview} alt="" class="max-h-40 rounded-box object-contain" />
{:else}
  <!-- Another player's text: rendered as text, never as markup. -->
  <p class="text-on-surface break-words whitespace-pre-wrap">
    {preview || $t('admin.contentUnavailable')}
  </p>
{/if}
{#if note}
  <p class="border-outline text-on-surface-variant text-body-small mt-2 border-l-2 pl-2">
    {note}
  </p>
{/if}
{#if reporterLabel}
  <p class="text-on-surface-variant text-body-small mt-2" data-testid="admin-reporter-label">
    {$t('admin.reporterAlias')}: {reporterLabel}
  </p>
{/if}
