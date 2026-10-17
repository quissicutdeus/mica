<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    EmptyState,
    MessageBar,
    ReportButton,
    ReportDialog,
    Skeleton,
    formatDate,
    useAppAction,
    useLocale,
    usePagedList
  } from '@mica/sdk';
  import type { DirectMessage, SparkMatch } from '@mica/shared/types';
  import { LIMITS, loadOlderMessages, messages, olderCursor, sendMessage } from '../store';

  /**
   * One match's thread: oldest at the top, newest at the bottom, scrolled down on arrival.
   *
   * Windowed with `usePagedList` (`olderAt: 'start'`, Messages' shape): scrolling to the top
   * reveals the held rows a page at a time, then walks the server's cursor, and the hook keeps
   * the reader's place as older lines appear above. Report is offered on their lines only —
   * reporting yourself is refused — and files against `mica_blabber_dms`, the table `dms` keeps.
   */
  let {
    match,
    loading
  }: {
    match: SparkMatch;
    loading: boolean;
  } = $props();

  const { t } = useLocale();
  const { run, busy } = useAppAction('spark');

  let draft = $state('');
  let reporting = $state<number | null>(null);

  /** The scroller, bound so the newest line can be brought into view. */
  let list: HTMLDivElement | undefined = $state();

  const page = usePagedList<DirectMessage>({
    items: () => $messages,
    olderAt: 'start',
    pageSize: 40,
    container: () => list ?? null,
    // Never rejects into the hook: a rejection would leave its loading guard set for good.
    loadOlder: () =>
      loadOlderMessages().catch((error) => {
        console.warn('micaOS Spark: could not load older messages', error);
        return false;
      }),
    hasMore: () => $olderCursor !== null
  });

  /** The newest line last pinned to; an older page must not yank the view down. */
  let pinnedTo = -1;

  $effect(() => {
    const newest = page.visible[page.visible.length - 1]?.id ?? -1;
    if (newest === pinnedTo || !list) return;
    pinnedTo = newest;
    list.scrollTop = list.scrollHeight;
  });

  const peer = $derived(match.profile.account_id);
  const name = $derived(match.profile.display_name || $t('spark.someone'));

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    const ok = await run(() => sendMessage(peer, body), { title: $t('spark.title') });
    if (ok) draft = '';
  };
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div
    class="flex-1 overflow-y-auto py-2"
    bind:this={list}
    onscroll={page.onScroll}
    data-testid="spark-thread"
  >
    {#if page.loading}
      <div class="text-on-surface-variant text-body-small py-1 text-center">…</div>
    {/if}

    {#if loading && $messages.length === 0}
      <div class="p-4"><Skeleton count={3} height="h-12" /></div>
    {:else if $messages.length === 0}
      <EmptyState title={$t('spark.nothingYet')} description={$t('spark.nothingYetHint')} />
    {:else}
      {#each page.visible as message (message.id)}
        {@const mine = message.to_account === peer}
        <!-- A sent bubble is a tinted container, so it hands its own `on-` role to everything
             inside it (MICA-102); a received one sits on the surface. -->
        <div
          class="flex px-4 py-1"
          class:justify-end={mine}
          data-testid="spark-message"
          data-message-id={message.id}
          data-mine={mine}
        >
          <div
            class="max-w-[80%] rounded-box px-3 py-2"
            class:bg-primary-container={mine}
            class:bg-surface-container={!mine}
          >
            <!-- Another player's text: rendered as text, never as markup. -->
            <p
              class="text-body-medium break-words whitespace-pre-wrap"
              class:text-on-primary-container={mine}
              class:text-on-surface={!mine}
            >
              {message.body}
            </p>
            <div class="mt-0.5 flex items-center gap-1">
              <p
                class="text-label-small"
                class:text-on-primary-container={mine}
                class:text-on-surface-variant={!mine}
              >
                {formatDate(message.created_at)}
              </p>
              {#if !mine}
                <ReportButton
                  subject={$t('spark.messageNoun')}
                  size="mini"
                  onclick={() => (reporting = message.id)}
                />
              {/if}
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <MessageBar
    bind:value={draft}
    placeholder={$t('spark.messagePlaceholder', { name })}
    maxlength={LIMITS.message}
    busy={$busy}
    onsend={() => void send()}
  />
</div>

{#if reporting !== null}
  <ReportDialog
    targetTable="mica_blabber_dms"
    targetId={reporting}
    appId="spark"
    onclose={() => (reporting = null)}
  />
{/if}
