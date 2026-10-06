<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { EmptyState, ListItem, Skeleton, useLocale } from '@mica/sdk';
  import type { JobLineThread } from '@mica/shared/types';
  import { ago } from '../time';

  /**
   * A job line's shared inbox (MICA-307): one row per player who has written to the line,
   * newest activity first, as the server ordered them.
   *
   * A thread whose newest message is the caller's has not been answered by anybody on the
   * line, and says so in words as well as colour — the marker is the one thing a dispatcher
   * scanning this list is looking for.
   */
  let {
    threads,
    loaded,
    failed,
    nameFor,
    onopen
  }: {
    threads: JobLineThread[];
    loaded: boolean;
    failed: boolean;
    /** The saved contact's name for a number, or the number itself. */
    nameFor: (number: string) => string;
    onopen: (conversationId: number) => void;
  } = $props();

  const { t } = useLocale();
</script>

<div class="divide-outline-variant pb-home-indicator divide-y" data-testid="line-inbox">
  {#if !loaded}
    <div class="p-4"><Skeleton count={3} height="h-16" /></div>
  {:else if failed && threads.length === 0}
    <EmptyState title={$t('jobs.inboxFailed')} description={$t('jobs.inboxFailedHint')} />
  {:else}
    {#each threads as thread (thread.conversation_id)}
      <ListItem onclick={() => onopen(thread.conversation_id)}>
        <div
          class="min-w-0 flex-1"
          data-testid="line-thread-row"
          data-awaiting={thread.awaiting_reply}
        >
          <div class="flex items-center gap-2">
            <span class="font-medium min-w-0 flex-1 truncate">
              {thread.from ? nameFor(thread.from) : $t('jobs.unknownCaller')}
            </span>
            <span class="text-on-surface-variant text-label-small shrink-0">
              {ago(thread.last_at, $t)}
            </span>
          </div>
          <div class="mt-0.5 flex items-center gap-2">
            <span class="text-on-surface-variant text-body-small min-w-0 flex-1 truncate">
              {thread.last_message || $t('jobs.photoSent')}
            </span>
            {#if thread.awaiting_reply}
              <span
                class="bg-error-container text-on-error-container text-label-small shrink-0 rounded-full px-2 py-0.5"
              >
                {$t('jobs.awaitingReply')}
              </span>
            {/if}
          </div>
        </div>
      </ListItem>
    {:else}
      <EmptyState title={$t('jobs.inboxEmpty')} description={$t('jobs.inboxEmptyHint')} />
    {/each}
  {/if}
</div>
