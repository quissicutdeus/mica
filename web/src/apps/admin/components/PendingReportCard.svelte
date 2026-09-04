<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { formatRelativeTime, useLocale } from '@mica/sdk';
  import type { Report } from '@mica/shared/types';
  import { CATEGORY_KEYS } from './labels';
  import ReportPreview from './ReportPreview.svelte';

  interface Props {
    report: Report;
    busy: boolean;
    onallow: () => void;
    onremove: () => void;
  }

  let { report, busy, onallow, onremove }: Props = $props();

  const { t } = useLocale();
  const category = $derived(
    CATEGORY_KEYS[report.category] ? $t(CATEGORY_KEYS[report.category]) : report.category
  );
</script>

<div class="bg-surface-container text-body-medium overflow-hidden rounded-box">
  <div class="flex items-start justify-between gap-3 p-4">
    <div class="min-w-0">
      <p class="text-error font-medium">{category}</p>
      <p class="text-on-surface-variant text-body-small mt-0.5">
        {$t('admin.reported', { when: formatRelativeTime(report.created_at) })}
      </p>
    </div>
    <span
      class="bg-surface text-on-surface-variant text-label-small shrink-0 rounded-chip px-2 py-0.5 font-mono"
    >
      #{report.id}
    </span>
  </div>

  <div class="border-outline-variant border-t px-4 py-3">
    <ReportPreview preview={report.target_preview} note={report.note} />
  </div>

  <div class="bg-surface-container-high grid grid-cols-2 gap-px">
    <button
      type="button"
      disabled={busy}
      onclick={onallow}
      class="bg-surface-container text-on-surface hover:bg-surface-container-high duration-short ease-standard cursor-pointer py-3 font-medium transition-colors disabled:opacity-50"
    >
      {$t('admin.allow')}
    </button>
    <button
      type="button"
      disabled={busy}
      onclick={onremove}
      class="bg-surface-container text-error hover:bg-surface-container-high duration-short ease-standard cursor-pointer py-3 font-medium transition-colors disabled:opacity-50"
    >
      {$t('admin.removeForEveryone')}
    </button>
  </div>
</div>
