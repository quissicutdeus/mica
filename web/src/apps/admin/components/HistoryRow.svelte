<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { formatRelativeTime, useLocale } from '@gos/sdk';
  import type { Report } from '@gos/shared/types';
  import { CATEGORY_KEYS, RESOLUTION_KEYS, isImage } from './labels';

  interface Props {
    report: Report;
    busy: boolean;
    onundo: () => void;
  }

  let { report, busy, onundo }: Props = $props();

  const { t } = useLocale();
  const category = $derived(
    CATEGORY_KEYS[report.category] ? $t(CATEGORY_KEYS[report.category]) : report.category
  );
  const resolution = $derived(
    RESOLUTION_KEYS[report.resolution] ? $t(RESOLUTION_KEYS[report.resolution]) : report.resolution
  );
</script>

<div class="bg-surface-container text-body-medium overflow-hidden rounded-box">
  <div class="flex items-start justify-between gap-3 p-4">
    <div class="min-w-0">
      <p class="text-on-surface font-medium">{category}</p>
      <p
        class="text-body-small mt-0.5 {report.resolution === 'actioned'
          ? 'text-error'
          : 'text-on-surface-variant'}"
      >
        {resolution} · {formatRelativeTime(report.updated_at)}
      </p>
    </div>
    <button
      type="button"
      disabled={busy}
      onclick={onundo}
      class="border-outline text-on-surface hover:bg-surface-container-high duration-short ease-standard text-body-small shrink-0 cursor-pointer rounded-box border px-3 py-1.5 transition-colors disabled:opacity-50"
    >
      {$t('admin.undo')}
    </button>
  </div>
  <p
    class="border-outline-variant text-on-surface-variant text-body-small truncate border-t px-4 py-2"
  >
    {isImage(report.target_preview) ? $t('admin.photo') : report.target_preview || '—'}
  </p>
</div>
