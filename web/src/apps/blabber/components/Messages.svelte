<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Avatar,
    DmInbox,
    DmThread,
    EmptyState,
    ReactionBar,
    ReportDialog,
    useLocale,
    initialsOf,
    type DirectMessage,
    type DirectMessageThread
  } from '@mica/sdk';
  import { useBlabber } from '../store';
  import type { Account } from '@mica/shared/types';
  import BlabBody from './BlabBody.svelte';

  /**
   * The little the header needs about a correspondent.
   *
   * Not the whole `Account`: the inbox row carries a handle and a display name and no more, and
   * a type demanding an avatar would force one of the two call sites to invent a field.
   */
  type DmPeer = Pick<Account, 'handle' | 'display_name'> & { avatar?: string | null };

  /**
   * The DM inbox, and one thread — the SDK's `DmInbox` and `DmThread` (MICA-392), with what is
   * Blabber's own laid over them: the peer's header, a body that links handles and tags, the
   * reactions under each line, and the report dialog against `mica_blabber_dms`.
   *
   * Strictly 1:1, so a thread is identified by the **peer account** rather than by a conversation
   * row — there is nothing to create before the first message, and nothing a third person could
   * be added to. That is the whole reason DMs here are not Conversations, which needs a
   * participants table precisely because its threads can grow.
   *
   * `peerAccount` is who the thread is with when the inbox has no row for them yet — a
   * conversation started from a profile, before either side has sent anything. Without it the
   * header resolved the peer out of `$dmThreads` alone and rendered `@` with a `?` avatar under
   * the literal title "Message".
   */
  let {
    peer = null,
    peerAccount = null,
    onopen,
    onpeername,
    onhandle,
    ontag
  }: {
    peer?: number | null;
    peerAccount?: DmPeer | null;
    onopen?: (peerAccountId: number | null, account?: DmPeer | null) => void;
    /** Reports the peer's name upward, so the screen title can be it rather than "Message". */
    onpeername?: (name: string | null) => void;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
  } = $props();

  const { t } = useLocale();

  const {
    activeAccount,
    dmThreads,
    loadDmThreads,
    dmReactions,
    loadDmReactions,
    toggleDmReaction
  } = useBlabber();

  // The badge and the header both read `$dmThreads`; opening the inbox refreshes it, as it did
  // when the inbox drew from that store itself.
  $effect(() => {
    if (peer === null) void loadDmThreads();
  });

  const thread = $derived($dmThreads.find((row) => row.peer_account_id === peer));
  /** The inbox's row wins once it exists; the handed-down account covers the first message. */
  const active = $derived(
    thread ?? (peerAccount ? { ...peerAccount, peer_account_id: peer } : undefined)
  );

  $effect(() => {
    onpeername?.(active ? active.display_name || `@${active.handle}` : null);
  });

  const openThread = (row: DirectMessageThread) =>
    onopen?.(row.peer_account_id, { handle: row.handle ?? '', display_name: row.display_name });

  /** Which DM is being reported, by id. Null when the dialog is closed. */
  let reportingDm = $state<number | null>(null);
</script>

{#snippet inboxEmpty()}
  <EmptyState title={$t('blabber.noMessages')} description={$t('blabber.noMessagesHint')} />
{/snippet}

{#snippet threadEmpty()}
  <EmptyState title={$t('blabber.nothingYet')} description={$t('blabber.nothingYetHint')} />
{/snippet}

{#snippet header()}
  <div class="border-outline-variant flex items-center gap-2 border-b px-4 py-2.5">
    <Avatar
      initials={initialsOf(active?.handle)}
      src={peerAccount?.avatar ?? ''}
      size="w-8 h-8"
      showSilhouette={false}
    />
    <button
      type="button"
      class="min-w-0 text-left hover:underline"
      onclick={() => active?.handle && onhandle?.(active.handle)}
    >
      <span class="text-on-surface text-body-medium block truncate">
        {active?.display_name || (active?.handle ? `@${active.handle}` : $t('blabber.message'))}
      </span>
      {#if active?.display_name && active.handle}
        <span class="text-on-surface-variant text-body-small block truncate">@{active.handle}</span>
      {/if}
    </button>
  </div>
{/snippet}

<!-- The bubble's own `on-` role, handed to everything inside it. A sent bubble is a tinted
     container, so `on-surface` is near-invisible on it (MICA-102). -->
{#snippet bubble(message: DirectMessage, mine: boolean)}
  <BlabBody
    body={message.body}
    class={mine ? 'text-on-primary-container' : 'text-on-surface'}
    {onhandle}
    {ontag}
  />
  <ReactionBar
    summary={$dmReactions[message.id]}
    ontoggle={(emoji: string) => toggleDmReaction(message.id, emoji)}
    class="mt-1"
  />
{/snippet}

{#if peer === null}
  <DmInbox appId="blabber" accountId={null} empty={inboxEmpty} onopen={openThread} />
{:else if $activeAccount}
  <!-- As whoever the header menu says is posting; a switch there reopens the thread. -->
  <DmThread
    appId="blabber"
    accountId={$activeAccount.id}
    peerAccountId={peer}
    emoji
    {header}
    empty={threadEmpty}
    {bubble}
    onreport={(message: DirectMessage) => (reportingDm = message.id)}
    onactivity={() => void loadDmThreads()}
    onpage={(rows: DirectMessage[]) => void loadDmReactions(rows.map((row) => row.id))}
  />
{/if}

{#if reportingDm !== null}
  <ReportDialog
    targetTable="mica_blabber_dms"
    targetId={reportingDm}
    appId="blabber"
    onclose={() => (reportingDm = null)}
  />
{/if}
