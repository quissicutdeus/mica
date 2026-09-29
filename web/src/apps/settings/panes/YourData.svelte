<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    ChevronRightIcon,
    SettingsSection,
    usePhoneNotification,
    useLocale
  } from '@mica/sdk';
  import { onMount } from 'svelte';
  import { PRIVACY_DELETE_CONFIRMATION } from '@mica/shared/contracts/privacy';
  import type {
    PrivacyDeleteResult,
    PrivacyExport,
    PrivacyExportCategory
  } from '@mica/shared/types';
  import { copyText } from '../clipboard';
  import {
    exportJson,
    holdsNothing,
    humanize,
    isRelayTimeout,
    listed,
    loadExport,
    outcomeOf,
    requestDelete,
    rowsJson
  } from '../yourData';

  const { t } = useLocale();
  const { toast } = usePhoneNotification();

  /**
   * What micaOS holds for this character, and the one way to erase it (MICA-168).
   *
   * Export is a view and a clipboard copy, never a download: `window.open` and anchor
   * navigation reload the CEF instance (AGENTS.md §6). Delete is guarded by a word the
   * *server* checks — this pane only offers the input, so a modified client cannot skip
   * the guard by skipping the pane. The button is enabled for any non-empty word for the
   * same reason: the server's refusal is the one the player sees, not a second opinion
   * kept in step with it here.
   *
   * A pane, not an app: it mounts when opened, so loading on mount is right here where
   * it would be wrong for a resident app (§11).
   */
  let exported = $state<PrivacyExport | null>(null);
  let loading = $state(true);
  let loadFailed = $state(false);
  /** The server's own words for why the export failed, e.g. "try again in 40s". */
  let loadError = $state<string | null>(null);
  /** After a delete the old list is stale; reloading is the player's call (rate limit). */
  let reloadNeeded = $state(false);
  let open = $state<string | null>(null);

  let word = $state('');
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);
  let timedOut = $state(false);
  let result = $state<PrivacyDeleteResult | null>(null);

  const load = async (): Promise<void> => {
    loading = true;
    loadFailed = false;
    loadError = null;
    reloadNeeded = false;
    try {
      exported = await loadExport();
    } catch (e) {
      exported = null;
      loadFailed = true;
      // The server's message is player-facing (a rate limit says how long to wait). A relay
      // timeout is the client's own, and says nothing the generic line does not.
      loadError = e instanceof Error && e.message && !isRelayTimeout(e) ? e.message : null;
    } finally {
      loading = false;
    }
  };

  onMount(() => {
    void load();
  });

  const categories = $derived(exported ? listed(exported) : []);
  const outcome = $derived(result ? outcomeOf(result) : null);

  /** A category's name: the catalog's, else the table name with its underscores taken out. */
  const label = (category: string): string => {
    const id = `settings.yourData.cat.${category}`;
    const text = $t(id);
    return text === id ? humanize(category) : text;
  };

  const copyAll = async (): Promise<void> => {
    if (!exported) return;
    const copied = await copyText(exportJson(exported));
    toast.show(
      copied
        ? { type: 'success', app: 'settings', message: $t('settings.yourData.copied') }
        : { type: 'error', app: 'settings', message: $t('settings.yourData.copyFailed') }
    );
  };

  const erase = async (): Promise<void> => {
    if (deleting) return;
    deleting = true;
    deleteError = null;
    timedOut = false;
    try {
      result = await requestDelete(word.trim());
      word = '';
      // Not re-fetched here: the export is rate limited, and a reload the player did not
      // ask for would spend the allowance the "Reload my data" button needs.
      exported = null;
      reloadNeeded = true;
    } catch (e) {
      // A relay timeout is not a refusal: the purge may still be running server-side, so
      // it must not say nothing happened. The server's own message (a wrong word) is shown
      // as it is; anything else gets the soft copy, because "try again" is the wrong
      // advice when the outcome is not known.
      timedOut = isRelayTimeout(e);
      deleteError = timedOut
        ? $t('settings.yourData.timedOut')
        : e instanceof Error && e.message
          ? e.message
          : $t('settings.yourData.failed');
    } finally {
      deleting = false;
    }
  };
</script>

{#snippet head(cat: PrivacyExportCategory)}
  <span class="min-w-0">
    <span class="text-on-surface block font-medium">{label(cat.category)}</span>
    {#if cat.truncated}
      <span class="text-on-surface-variant text-body-small block">
        {#if cat.rows.length === 0}
          {$t('settings.yourData.notIncluded')}
        {:else if cat.truncated === 'rows'}
          {$t('settings.yourData.truncatedRows', { shown: cat.rows.length })}
        {:else}
          {$t('settings.yourData.truncatedSize', { shown: cat.rows.length })}
        {/if}
      </span>
    {/if}
    {#if cat.withheld.length > 0}
      <span class="text-on-surface-variant text-body-small block">
        {$t('settings.yourData.withheld', { columns: cat.withheld.join(', ') })}
      </span>
    {/if}
  </span>
{/snippet}

<div class="space-y-6 p-4">
  <SettingsSection
    title={$t('settings.yourData.export')}
    footer={$t('settings.yourData.exportFooter')}
  >
    {#if loading && !exported}
      <p class="text-on-surface-variant text-body-medium p-4" role="status">
        {$t('settings.yourData.loading')}
      </p>
    {:else if loadFailed}
      <div class="space-y-3 p-4">
        <p class="text-error text-body-medium" role="alert" data-testid="your-data-load-error">
          {loadError ?? $t('settings.yourData.loadFailed')}
        </p>
        <Button variant="secondary" onclick={load}>{$t('settings.yourData.retry')}</Button>
      </div>
    {:else if reloadNeeded && !exported}
      <div class="space-y-3 p-4" data-testid="your-data-reload">
        <p class="text-on-surface-variant text-body-medium">
          {$t('settings.yourData.reloadHint')}
        </p>
        <Button variant="secondary" onclick={load}>{$t('settings.yourData.reload')}</Button>
      </div>
    {:else if exported && holdsNothing(exported)}
      <p class="text-on-surface-variant text-body-medium p-4">{$t('settings.yourData.empty')}</p>
    {:else if exported}
      <div class="divide-outline-variant divide-y" data-testid="your-data-categories">
        {#each categories as cat (cat.category)}
          <div>
            {#if cat.rows.length > 0}
              <button
                type="button"
                onclick={() => (open = open === cat.category ? null : cat.category)}
                aria-expanded={open === cat.category}
                aria-controls="your-data-{cat.category}"
                data-testid="your-data-cat-{cat.category}"
                class="hover:bg-surface-container-high active:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between gap-3 p-4 text-left transition-colors"
              >
                {@render head(cat)}
                <span class="flex shrink-0 items-center gap-2">
                  <span class="text-on-surface font-mono">{cat.rows.length}</span>
                  <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
                </span>
              </button>
            {:else}
              <!-- Cut for size, so there is nothing to open. Listed all the same: leaving it
                   out would read as "nothing held here". -->
              <div
                class="flex w-full items-center justify-between gap-3 p-4"
                data-testid="your-data-cat-{cat.category}"
              >
                {@render head(cat)}
                <span class="text-on-surface-variant font-mono" aria-hidden="true">–</span>
              </div>
            {/if}
            {#if open === cat.category}
              <!-- A read-only textarea rather than a scrolling `<pre>`: natively focusable and
                   scrollable from the keyboard, and the text can be selected in place. -->
              <textarea
                id="your-data-{cat.category}"
                readonly
                value={rowsJson(cat)}
                aria-label={$t('settings.yourData.rowsOf', { category: label(cat.category) })}
                class="bg-surface-container-low text-on-surface text-body-small block h-40 w-full resize-none p-4 font-mono"
              ></textarea>
            {/if}
          </div>
        {/each}
      </div>
      {#if exported.truncated}
        <p class="text-on-surface-variant text-body-small px-4 pt-3" data-testid="your-data-cut">
          {$t('settings.yourData.exportCut')}
        </p>
      {/if}
      <div class="p-4">
        <Button class="w-full" variant="secondary" onclick={copyAll}>
          {$t('settings.yourData.copyAll')}
        </Button>
      </div>
    {/if}
  </SettingsSection>

  <SettingsSection title={$t('settings.yourData.delete')}>
    {#if result}
      <div class="space-y-4 p-4" data-testid="your-data-result" role="status">
        <p class="text-on-surface text-body-large font-medium">
          {outcome === 'partial' ? $t('settings.yourData.partial') : $t('settings.yourData.done')}
        </p>
        <div class="text-body-medium space-y-1">
          <p class="text-on-surface" data-testid="your-data-removed">
            {$t('settings.yourData.removed', { count: result.removed })}
          </p>
          <p class="text-on-surface" data-testid="your-data-kept">
            {result.kept === null
              ? $t('settings.yourData.keptUnknown')
              : $t('settings.yourData.kept', { count: result.kept })}
          </p>
        </div>
        {#if outcome === 'partial'}
          <p class="text-error text-body-medium" data-testid="your-data-failed">
            {$t('settings.yourData.failedCategories', {
              categories: result.failed.map(label).join(', ')
            })}
          </p>
        {/if}
      </div>
    {:else}
      <div class="space-y-3 p-4">
        <!-- Said plainly, before the word is asked for. -->
        <div
          class="bg-error-container text-on-error-container text-body-medium space-y-2 rounded-box p-4"
        >
          <p class="font-medium">{$t('settings.yourData.warnTitle')}</p>
          <div class="space-y-1">
            <p>{$t('settings.yourData.warnIrreversible')}</p>
            <p>{$t('settings.yourData.warnReports')}</p>
            <p>{$t('settings.yourData.warnLogged')}</p>
            <p>{$t('settings.yourData.warnModeration')}</p>
          </div>
        </div>
        <label class="block">
          <span class="text-on-surface-variant text-body-small mb-1 block">
            {$t('settings.yourData.typeWord', { word: PRIVACY_DELETE_CONFIRMATION })}
          </span>
          <input
            type="text"
            bind:value={word}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-testid="your-data-word"
            class="bg-surface-container-highest text-on-surface text-body-medium focus:ring-focus-ring w-full rounded-box px-4 py-3 focus:ring-1 focus:outline-none"
          />
        </label>
        {#if deleteError}
          <p class="text-error text-body-medium" role="alert" data-testid="your-data-error">
            {deleteError}
          </p>
          {#if timedOut}
            <Button variant="secondary" onclick={load}>{$t('settings.yourData.reload')}</Button>
          {/if}
        {/if}
        <Button
          class="w-full"
          variant="danger"
          disabled={deleting || word.trim() === ''}
          onclick={erase}
        >
          {deleting ? $t('settings.yourData.deleting') : $t('settings.yourData.deleteButton')}
        </Button>
      </div>
    {/if}
  </SettingsSection>
</div>
