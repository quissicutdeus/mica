<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    CloseIcon,
    EmptyState,
    focusTrap,
    formatDate,
    formatRelativeTime,
    formatTime,
    messageOf,
    useLocale
  } from '@mica/sdk';
  import type { Report } from '@mica/shared/types';
  import { isImage, REASON_KEYS, SEALED_VALUE, type ReportVersion } from './labels';

  interface Props {
    /** The report whose row's earlier versions are shown. */
    report: Report;
    /** Reads them, newest first; rejects when the server did not answer. */
    load: (id: number) => Promise<ReportVersion[]>;
    onclose: () => void;
  }

  let { report, load, onclose }: Props = $props();

  const { t } = useLocale();

  // Two fields, not one union: a union does not narrow in `{:else if}` (lint:web).
  /** `null` until the first answer — distinct from `[]`, which is "never edited". */
  let versions = $state<ReportVersion[] | null>(null);
  /** Set when the last read failed: the server's own words where it gave some, else ''. */
  let failed = $state<string | null>(null);
  let loading = $state(false);

  const fetchVersions = async () => {
    loading = true;
    failed = null;
    try {
      versions = await load(report.id);
    } catch (error) {
      // A failed read is said as a failure, never shown as an empty history.
      failed = messageOf(error, '');
    } finally {
      loading = false;
    }
  };

  // Read when the dialog opens, which is a staff member asking — not the app mounting, so
  // this is not the resident-app load `onAppForeground` is for. Each open reads afresh.
  void fetchVersions();

  const when = (iso: string | null) =>
    iso ? `${formatDate(iso)} ${formatTime(iso)} · ${formatRelativeTime(iso, $t)}` : '';

  const editorLabel = (byOwner: boolean | null) =>
    byOwner === null
      ? $t('admin.versionBySystem')
      : byOwner
        ? $t('admin.versionByOwner')
        : $t('admin.versionByOther');

  /** Another player's old text, as text: the padlock, a photo and an empty value say so. */
  const shown = (value: string | null) => {
    if (value === null || value === '') return $t('admin.versionEmpty');
    if (value === SEALED_VALUE) return $t('admin.versionSealed');
    if (isImage(value)) return $t('admin.photo');
    return value;
  };

  let dialogRef = $state<HTMLElement | null>(null);

  /** Announce the panel on open, and start Tab inside it — see `ConfirmDialog` (MICA-410). */
  $effect(() => {
    dialogRef?.focus({ preventScroll: true });
  });
</script>

<div
  class="bg-scrim absolute inset-0 z-50 flex items-center justify-center px-6 pt-4 pb-home-indicator backdrop-blur-sm"
>
  <div
    bind:this={dialogRef}
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label={$t('admin.editHistory')}
    tabindex="-1"
    data-testid="admin-edit-history"
    class="bg-surface-container shadow-elevation-5 flex max-h-full w-full max-w-3xl flex-col rounded-box outline-none"
  >
    <div class="border-outline-variant flex items-center justify-between gap-3 border-b p-4">
      <div class="min-w-0">
        <h2 class="text-on-surface text-title-medium font-medium">{$t('admin.editHistory')}</h2>
        <p class="text-on-surface-variant text-body-small">
          {$t('admin.editHistoryHint', { id: report.id })}
        </p>
      </div>
      <button
        type="button"
        onclick={onclose}
        aria-label={$t('admin.closeEditHistory')}
        class="text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface duration-short ease-standard shrink-0 cursor-pointer rounded-full p-1 transition-colors"
      >
        <CloseIcon class="size-icon-md" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      {#if failed !== null}
        <div class="space-y-3" role="alert">
          <p class="text-error text-body-medium">{$t('admin.versionsFailed')}</p>
          {#if failed}
            <p class="text-on-surface-variant text-body-small break-words">{failed}</p>
          {/if}
          <Button variant="secondary" onclick={fetchVersions} disabled={loading}>
            {$t('admin.retry')}
          </Button>
        </div>
      {:else if versions === null}
        <p class="text-on-surface-variant text-body-medium" aria-live="polite">
          {$t('admin.versionsLoading')}
        </p>
      {:else if versions.length === 0}
        <EmptyState title={$t('admin.noVersions')} description={$t('admin.noVersionsHint')} />
      {:else}
        <ol class="space-y-3" aria-label={$t('admin.editHistory')}>
          {#each versions as version (version.id)}
            <li
              class="bg-surface-container-low text-body-medium rounded-box p-3"
              data-testid="admin-version"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="bg-surface-container-highest text-on-surface text-label-small rounded-chip px-2 py-0.5 font-medium"
                >
                  {REASON_KEYS[version.reason] ? $t(REASON_KEYS[version.reason]) : version.reason}
                </span>
                <span class="text-on-surface-variant text-body-small">
                  {editorLabel(version.by_owner)}
                </span>
              </div>
              <p class="text-on-surface-variant text-body-small mt-1">
                {$t('admin.versionReplaced', { when: when(version.replaced_at) })}
              </p>
              {#if version.written_at}
                <p class="text-on-surface-variant text-body-small">
                  {$t('admin.versionWritten', { when: when(version.written_at) })}
                </p>
              {/if}
              {#if version.values.length === 0}
                <p class="text-on-surface-variant text-body-small mt-2 italic">
                  {$t('admin.versionNoValues')}
                </p>
              {:else}
                <dl class="mt-2 space-y-2">
                  {#each version.values as entry (entry.column)}
                    <div>
                      <dt class="text-on-surface-variant text-label-small font-mono">
                        {entry.column}
                      </dt>
                      <!-- Another player's text: rendered as text, never as markup. -->
                      <dd class="text-on-surface break-words whitespace-pre-wrap">
                        {shown(entry.value)}
                      </dd>
                    </div>
                  {/each}
                </dl>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</div>
