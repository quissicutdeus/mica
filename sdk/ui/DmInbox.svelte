<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import type { DirectMessageThread } from '../vocabulary/directMessages';
  import { useDirectMessages } from '../host/useDirectMessages';
  import { useAppEvents } from '../host/useAppEvents';
  import { formatDate } from '../lib/formatters';
  import { initialsOf } from '../lib/initials';
  import { t } from '../i18n';
  import Avatar from './Avatar.svelte';
  import EmptyState from './EmptyState.svelte';
  import Skeleton from './Skeleton.svelte';
  import './messages';

  /**
   * A direct-message inbox (MICA-392): one row per correspondent, the most recently active
   * first, each with who they are, the last line said and how much of it is unread.
   *
   * It reads `useDirectMessages(appId).threads()` on mount and again on every live `dm` push
   * for the app, so a message arriving while it is on screen moves its row to the top. A
   * replayed push is skipped: the read on mount already covers it.
   *
   * `accountId` narrows the list to one of the player's accounts, read off each thread's last
   * message, since `threads()` answers across all of them. A peer two of the player's accounts
   * both write to is one row on the server, under whichever spoke last, and its `unread` is
   * the two accounts' together. `null` keeps every account's rows.
   */
  interface Props {
    /** The app the inbox belongs to. In a frame the shell replaces it with the frame's own. */
    appId: string;
    /** The account the player is acting as, or `null` for every account they hold here. */
    accountId: number | null;
    /** What an empty inbox says: a title, or a snippet drawn in its place. */
    empty?: string | Snippet;
    /** A row was tapped. The thread carries the peer's id, handle and display name. */
    onopen: (thread: DirectMessageThread) => void;
  }

  let { appId, accountId, empty, onopen }: Props = $props();

  // Resolved once, at init, on purpose: a host hook has to run while the component is being
  // set up (it reads the Svelte-context host), and an inbox handed a different app mid-life
  // would be a different inbox. `appId` is an app's own constant at every call site.
  // svelte-ignore state_referenced_locally
  const dms = useDirectMessages(appId);
  // svelte-ignore state_referenced_locally
  const events = useAppEvents(appId);

  let threads = $state<DirectMessageThread[]>([]);
  let loaded = $state(false);

  /** Reads never reject by contract; this holds that even if the wire does. */
  const load = async () => {
    try {
      threads = (await dms.threads()) ?? [];
    } catch (error) {
      console.warn('[micaOS] Could not read the inbox.', error);
    }
    loaded = true;
  };

  onMount(() => void load());

  events.on('dm', (event) => {
    if (!event.replayed) void load();
  });

  const rows = $derived(
    threads
      .filter(
        (thread) =>
          accountId === null ||
          thread.last?.from_account === accountId ||
          thread.last?.to_account === accountId
      )
      .sort((a, b) => (b.last?.id ?? 0) - (a.last?.id ?? 0))
  );

  const nameOf = (thread: DirectMessageThread) =>
    thread.display_name || (thread.handle ? `@${thread.handle}` : $t('ui.dmSomeone'));
</script>

<div class="min-h-0 flex-1 overflow-y-auto" data-testid="dm-inbox">
  {#if !loaded}
    <div class="p-4"><Skeleton count={3} height="h-16" /></div>
  {:else if rows.length === 0}
    {#if typeof empty === 'function'}
      {@render empty()}
    {:else}
      <EmptyState
        title={empty ?? $t('ui.dmNoMessages')}
        description={empty === undefined ? $t('ui.dmNoMessagesHint') : undefined}
      />
    {/if}
  {:else}
    {#each rows as thread (thread.peer_account_id)}
      {@const mine = thread.last !== null && thread.last.to_account === thread.peer_account_id}
      <button
        type="button"
        class="border-outline-variant hover:bg-surface-container duration-short ease-standard flex w-full cursor-pointer items-center gap-3 border-b px-4 py-3 text-left transition-colors"
        onclick={() => onopen(thread)}
        data-testid="dm-inbox-row"
        data-peer-account-id={thread.peer_account_id}
      >
        <Avatar initials={initialsOf(thread.handle)} size="w-10 h-10" showSilhouette={false} />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-on-surface text-body-medium min-w-0 truncate font-semibold">
              {nameOf(thread)}
            </span>
            {#if thread.display_name && thread.handle}
              <span class="text-on-surface-variant text-body-small min-w-0 flex-1 truncate">
                @{thread.handle}
              </span>
            {:else}
              <span class="flex-1"></span>
            {/if}
            {#if thread.last}
              <span class="text-on-surface-variant text-label-small shrink-0">
                {formatDate(thread.last.created_at)}
              </span>
            {/if}
          </div>
          <!-- Another player's text: rendered as text, never as markup. -->
          <p
            class="text-body-small truncate"
            class:text-on-surface={thread.unread > 0}
            class:text-on-surface-variant={thread.unread === 0}
          >
            {mine ? '↪ ' : ''}{thread.last?.body ?? ''}
          </p>
        </div>
        {#if thread.unread > 0}
          <span
            class="bg-primary-container text-on-primary-container text-label-small shrink-0 rounded-full px-2 py-0.5"
            aria-label={$t('ui.dmUnread', { count: thread.unread })}
            data-testid="dm-inbox-unread"
          >
            {thread.unread}
          </span>
        {/if}
      </button>
    {/each}
  {/if}
</div>
