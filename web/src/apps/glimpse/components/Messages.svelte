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
    ReportDialog,
    useLocale,
    initialsOf,
    type DirectMessage,
    type DirectMessageThread
  } from '@mica/sdk';
  import type { GlimpsePeer } from '../store';

  /**
   * Glimpse's direct messages (MICA-393): the SDK's `DmInbox` and `DmThread` (MICA-392) as the
   * active Glimpse account, with what is Glimpse's laid over them — the peer's avatar and handle
   * above the thread, and the report dialog against `mica_blabber_dms`, the table `dms` keeps for
   * every app.
   *
   * Plain text bubbles and no emoji picker: Glimpse has no reaction UI for a DM, and a picker
   * whose picks went nowhere but the draft would be one more thing to explain.
   *
   * `peer` is null for the inbox. The thread is keyed by the peer's account, so a conversation
   * started from a profile needs nothing created before its first message.
   */
  let {
    accountId,
    peer = null,
    onopen,
    onhandle
  }: {
    /** The active Glimpse account — the inbox is narrowed to it, and the thread sent as it. */
    accountId: number;
    peer?: GlimpsePeer | null;
    onopen: (peer: GlimpsePeer) => void;
    onhandle?: (handle: string) => void;
  } = $props();

  const { t } = useLocale();

  /** Which line is being reported, by id. Null when the dialog is closed. */
  let reporting = $state<number | null>(null);

  const openRow = (row: DirectMessageThread) =>
    onopen({
      id: row.peer_account_id,
      handle: row.handle ?? '',
      display_name: row.display_name
    });
</script>

{#snippet inboxEmpty()}
  <EmptyState title={$t('glimpse.noMessages')} description={$t('glimpse.noMessagesHint')} />
{/snippet}

{#snippet threadEmpty()}
  <EmptyState title={$t('glimpse.nothingYet')} description={$t('glimpse.nothingYetHint')} />
{/snippet}

{#snippet header()}
  <div
    class="border-outline-variant flex items-center gap-2 border-b px-4 py-2.5"
    data-testid="glimpse-dm-header"
  >
    <Avatar
      initials={initialsOf(peer?.handle)}
      src={peer?.avatar ?? ''}
      size="w-8 h-8"
      showSilhouette={false}
    />
    <button
      type="button"
      class="min-w-0 text-left hover:underline"
      onclick={() => peer?.handle && onhandle?.(peer.handle)}
    >
      <span class="text-on-surface text-body-medium block truncate">
        {peer?.display_name || (peer?.handle ? `@${peer.handle}` : $t('glimpse.message'))}
      </span>
      {#if peer?.display_name && peer.handle}
        <span class="text-on-surface-variant text-body-small block truncate">@{peer.handle}</span>
      {/if}
    </button>
  </div>
{/snippet}

{#if peer === null}
  <!-- `pb-20` clears the nav the inbox shares the screen with. -->
  <div class="flex min-h-0 flex-1 flex-col pb-20" data-testid="glimpse-messages">
    <DmInbox appId="glimpse" {accountId} empty={inboxEmpty} onopen={openRow} />
  </div>
{:else}
  <DmThread
    appId="glimpse"
    {accountId}
    peerAccountId={peer.id}
    placeholder={$t('glimpse.messagePlaceholder', { handle: peer.handle })}
    {header}
    empty={threadEmpty}
    onreport={(message: DirectMessage) => (reporting = message.id)}
  />
{/if}

{#if reporting !== null}
  <ReportDialog
    targetTable="mica_blabber_dms"
    targetId={reporting}
    appId="glimpse"
    onclose={() => (reporting = null)}
  />
{/if}
