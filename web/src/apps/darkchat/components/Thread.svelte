<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    EmptyState,
    formatDate,
    MessageBar,
    ReportButton,
    ReportDialog,
    Skeleton,
    useAppAction,
    useLocale
  } from '@mica/sdk';
  import type { DarkchatChannel, DarkchatMessage } from '@mica/shared/types';
  import { BODY_MAX, loadOlder, olderCursor, sendMessage } from '../store';

  /**
   * One channel's thread: oldest at the top, newest at the bottom, scrolled down on arrival.
   *
   * My own lines sit on the right; everyone else's on the left under their alias, a script's
   * with a Bot badge. Report is offered only on a line that is somebody else's and not a
   * script's — reporting yourself is refused, and a script's line has nobody behind it to act on.
   */
  let {
    channel,
    rows,
    loading
  }: { channel: DarkchatChannel; rows: DarkchatMessage[] | undefined; loading: boolean } = $props();

  const { t } = useLocale();
  const { run, busy } = useAppAction('darkchat');

  let draft = $state('');
  let reporting = $state<number | null>(null);
  let loadingOlder = $state(false);

  const hasOlder = $derived(($olderCursor[channel.id] ?? null) !== null);

  /** The scroller, bound so the newest line can be brought into view. */
  let list: HTMLDivElement | undefined = $state();
  /** The id of the newest line last pinned to; an older page must not yank the view down. */
  let pinnedTo = -1;

  $effect(() => {
    const newest = rows?.[rows.length - 1]?.id ?? -1;
    if (newest === pinnedTo || !list) return;
    pinnedTo = newest;
    list.scrollTop = list.scrollHeight;
  });

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    const ok = await run(() => sendMessage(channel.id, body), { title: $t('darkchat.title') });
    if (ok) draft = '';
  };

  const older = async () => {
    loadingOlder = true;
    try {
      await run(() => loadOlder(channel.id), { title: $t('darkchat.title') });
    } finally {
      loadingOlder = false;
    }
  };
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex-1 overflow-y-auto py-2" bind:this={list} data-testid="darkchat-thread">
    <p class="text-on-surface-variant text-body-small px-4 py-2 text-center">
      {$t('darkchat.ephemeral')}
    </p>
    {#if hasOlder}
      <div class="flex justify-center py-1">
        <button
          type="button"
          class="text-primary text-label-large cursor-pointer px-3 py-1.5 disabled:opacity-50"
          disabled={loadingOlder}
          onclick={() => void older()}
        >
          {$t('darkchat.olderMessages')}
        </button>
      </div>
    {/if}

    {#if rows === undefined && loading}
      <div class="p-4"><Skeleton count={3} height="h-12" /></div>
    {:else if !rows || rows.length === 0}
      <EmptyState title={$t('darkchat.noMessages')} description={$t('darkchat.noMessagesHint')} />
    {:else}
      {#each rows as message (message.id)}
        <!-- A sent bubble is a tinted container, so it hands its own `on-` role to everything
             inside it (MICA-102); a received one sits on the surface. -->
        <div
          class="flex px-4 py-1"
          class:justify-end={message.mine}
          data-testid="darkchat-message"
          data-message-id={message.id}
          data-mine={message.mine}
          data-bot={message.bot}
        >
          <div
            class="max-w-[80%] rounded-box px-3 py-2"
            class:bg-primary-container={message.mine}
            class:bg-surface-container={!message.mine}
          >
            {#if !message.mine}
              <p class="text-body-small flex items-center gap-1.5">
                <span class="text-on-surface truncate font-semibold">{message.alias}</span>
                {#if message.bot}
                  <span
                    class="bg-surface-container-highest text-on-surface-variant text-label-small shrink-0 rounded-chip px-1.5"
                    data-testid="darkchat-bot-badge"
                  >
                    {$t('darkchat.bot')}
                  </span>
                {/if}
              </p>
            {/if}
            <!-- Another player's text: rendered as text, never as markup. -->
            <p
              class="text-body-medium break-words whitespace-pre-wrap"
              class:text-on-primary-container={message.mine}
              class:text-on-surface={!message.mine}
            >
              {message.body}
            </p>
            <div class="mt-0.5 flex items-center gap-1">
              <p
                class="text-label-small"
                class:text-on-primary-container={message.mine}
                class:text-on-surface-variant={!message.mine}
              >
                {formatDate(message.created_at)}
              </p>
              {#if !message.mine && !message.bot}
                <ReportButton
                  subject={$t('darkchat.messageNoun')}
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
    placeholder={$t('darkchat.messageAs', { alias: channel.my_alias })}
    maxlength={BODY_MAX}
    busy={$busy}
    onsend={() => void send()}
  />
</div>

{#if reporting !== null}
  <ReportDialog
    targetTable="mica_darkchat_messages"
    targetId={reporting}
    appId="darkchat"
    onclose={() => (reporting = null)}
  />
{/if}
