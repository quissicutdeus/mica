<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { DirectMessage } from '../vocabulary/directMessages';
  import { useDirectMessages } from '../host/useDirectMessages';
  import { useAppEvents } from '../host/useAppEvents';
  import { usePagedList } from '../kit/usePagedList.svelte';
  import { formatDate } from '../lib/formatters';
  import { isRefusal } from '../lib/errors';
  import { t } from '../i18n';
  import EmojiPicker from './EmojiPicker.svelte';
  import EmptyState from './EmptyState.svelte';
  import MessageBar from './MessageBar.svelte';
  import ReportButton from './ReportButton.svelte';
  import Skeleton from './Skeleton.svelte';
  import './messages';

  /**
   * One direct-message thread between two accounts in an app (MICA-392): oldest at the top,
   * newest at the bottom, with the composer under it.
   *
   * Written once here because Blabber and Spark each had their own and Glimpse was about to
   * write a third. What every copy had to get right is in this file: the newest page first
   * and older pages on scroll (`usePagedList`, `olderAt: 'start'`, which keeps the reader's
   * place), the thread marked read on open, a `dm` push merged **by id** so a line already on
   * screen is not shown twice, and a failed send kept in the field with the reason beside it.
   *
   * What stays with the app is what is genuinely the app's: who the peer is (`header`), what
   * a line looks like when it is more than text (`bubble`), whether a line can be reported
   * (`onreport` — the app owns the dialog and the table), and anything it derives from the
   * inbox, such as a badge (`onactivity`), and anything keyed on the lines it holds, such as
   * reactions (`onpage`).
   *
   * **A failure is shown here, never toasted.** In a `core: false` frame the toast facet is a
   * read-only twin with no `show` (MICA-254), and a send that fails silently is worse than
   * one that says so. A refusal the server keyed for the player shows its own words; anything
   * else shows one generic line.
   *
   * No `<form>`: a sandboxed frame has no `allow-forms`, so a submit never fires there.
   * `MessageBar` sends on Enter and on its button.
   */
  interface Props {
    /** The app the thread belongs to. In a frame the shell replaces it with the frame's own. */
    appId: string;
    /** The account the player is acting as, one of their own in `appId`. */
    accountId: number;
    /** The account at the other end. */
    peerAccountId: number;
    /** The longest body the composer accepts. 500 is the shared column's width. */
    bodyMax?: number;
    /** The composer's hint. Defaults to the SDK's "Message". */
    placeholder?: string;
    /** Show the emoji picker above the composer; a pick is typed into the draft. */
    emoji?: boolean;
    /** Drawn above the messages: who the thread is with. */
    header?: Snippet;
    /** What an empty thread says: a title, or a snippet drawn in its place. */
    empty?: string | Snippet;
    /**
     * A line's content, in place of its plain text. `mine` says which side sent it, so the
     * snippet can use the bubble's own `on-` role. **Render the body as text**: it is another
     * player's words.
     */
    bubble?: Snippet<[message: DirectMessage, mine: boolean]>;
    /** Offered on the other side's lines only, since reporting yourself is refused. */
    onreport?: (message: DirectMessage) => void;
    /** The thread was read or written to, so whatever was derived from `threads()` is stale. */
    onactivity?: () => void;
    /**
     * Lines arrived: the rows **that read or send just brought in**, never the whole list and
     * never empty. Fired after the first page, each older page, a push's newest page (which
     * may repeat lines already held, merged by id) and a send. For loading what is keyed on a
     * line's id, such as its reactions.
     */
    onpage?: (rows: DirectMessage[]) => void;
  }

  let {
    appId,
    accountId,
    peerAccountId,
    bodyMax = 500,
    placeholder,
    emoji = false,
    header,
    empty,
    bubble,
    onreport,
    onactivity,
    onpage
  }: Props = $props();

  // Resolved once, at init, on purpose: a host hook has to run while the component is being
  // set up (it reads the Svelte-context host), and a thread handed a different app mid-life
  // would be a different thread. `appId` is an app's own constant at every call site.
  // svelte-ignore state_referenced_locally
  const dms = useDirectMessages(appId);
  // svelte-ignore state_referenced_locally
  const events = useAppEvents(appId);

  /** Held **oldest first**, so a send appends. The wire answers newest first. */
  let rows = $state<DirectMessage[]>([]);
  /** Where the next older page starts, or null at the first message. */
  let cursor = $state<number | null>(null);
  let loading = $state(true);
  let draft = $state('');
  let sending = $state(false);
  let failure = $state<string | null>(null);

  /** Bumped per (account, peer); an answer for an older pair is dropped on arrival. */
  let generation = 0;

  /** The scroller, bound so the newest line can be brought into view. */
  let list: HTMLDivElement | undefined = $state();

  /** Merge by id, oldest first: a line already held is replaced, never shown twice. */
  const merge = (incoming: DirectMessage[]) => {
    const arriving = incoming.map((row) => row.id);
    rows = [...rows.filter((row) => !arriving.includes(row.id)), ...incoming].sort(
      (a, b) => a.id - b.id
    );
  };

  /** Hand the app the lines that just arrived, if any did. */
  const arrived = (incoming: DirectMessage[]) => {
    if (incoming.length > 0) onpage?.(incoming);
  };

  /** Reads never reject by contract; this holds that even if the wire does. */
  const readPage = async (account: number, peer: number, from: number | null) => {
    try {
      const reply = await dms.thread({
        account_id: account,
        peer_account_id: peer,
        ...(from === null ? {} : { cursor: from })
      });
      return { rows: reply?.rows ?? [], nextCursor: reply?.nextCursor ?? null };
    } catch (error) {
      console.warn('[micaOS] Could not read the thread.', error);
      return { rows: [], nextCursor: null };
    }
  };

  const markRead = async (account: number, peer: number) => {
    try {
      await dms.markRead({ account_id: account, peer_account_id: peer });
    } catch (error) {
      console.warn('[micaOS] Could not mark the thread read.', error);
    }
    onactivity?.();
  };

  const open = async (account: number, peer: number) => {
    const mine = ++generation;
    rows = [];
    cursor = null;
    loading = true;
    failure = null;
    page.reset();
    const reply = await readPage(account, peer, null);
    if (mine !== generation) return;
    rows = [...reply.rows].reverse();
    cursor = reply.nextCursor;
    arrived(rows);
    loading = false;
    await markRead(account, peer);
  };

  $effect(() => {
    const account = accountId;
    const peer = peerAccountId;
    untrack(() => void open(account, peer));
  });

  const loadOlder = async (): Promise<boolean> => {
    if (cursor === null) return false;
    const mine = generation;
    const reply = await readPage(accountId, peerAccountId, cursor);
    if (mine !== generation) return false;
    cursor = reply.nextCursor;
    merge(reply.rows);
    arrived(reply.rows);
    return reply.rows.length > 0;
  };

  const page = usePagedList<DirectMessage>({
    items: () => rows,
    olderAt: 'start',
    pageSize: 40,
    container: () => list ?? null,
    loadOlder,
    hasMore: () => cursor !== null
  });

  /** The newest line last pinned to; an older page must not yank the view down. */
  let pinnedTo = -1;

  $effect(() => {
    const newest = page.visible[page.visible.length - 1]?.id ?? -1;
    if (newest === pinnedTo || !list) return;
    pinnedTo = newest;
    list.scrollTop = list.scrollHeight;
  });

  /**
   * The peer wrote. The push names the sender and not the line, so this takes the newest
   * page and merges by id: whatever was already on screen, my own send included, stays one
   * row. A replay on mount is already covered by the read `open` just made.
   */
  events.on<{ peer_account_id?: unknown }>('dm', (event) => {
    if (event.replayed || event.payload?.peer_account_id !== peerAccountId) return;
    const mine = generation;
    const account = accountId;
    const peer = peerAccountId;
    void readPage(account, peer, null).then((reply) => {
      if (mine !== generation) return;
      merge(reply.rows);
      arrived(reply.rows);
      return markRead(account, peer);
    });
  });

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    sending = true;
    failure = null;
    const mine = generation;
    try {
      const created = await dms.send({
        account_id: accountId,
        peer_account_id: peerAccountId,
        body
      });
      if (mine !== generation) return;
      merge([created]);
      arrived([created]);
      draft = '';
      onactivity?.();
    } catch (error) {
      if (mine !== generation) return;
      failure = isRefusal(error) && error.message ? error.message : $t('ui.dmSendFailed');
    } finally {
      sending = false;
    }
  };
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="dm-thread">
  {@render header?.()}

  <div
    class="min-h-0 flex-1 overflow-y-auto py-2"
    bind:this={list}
    onscroll={page.onScroll}
    data-testid="dm-thread-messages"
  >
    {#if page.loading}
      <div class="text-on-surface-variant text-body-small py-1 text-center">…</div>
    {/if}

    {#if loading && rows.length === 0}
      <div class="p-4"><Skeleton count={3} height="h-12" /></div>
    {:else if rows.length === 0}
      {#if typeof empty === 'function'}
        {@render empty()}
      {:else}
        <EmptyState
          title={empty ?? $t('ui.dmNothingYet')}
          description={empty === undefined ? $t('ui.dmNothingYetHint') : undefined}
        />
      {/if}
    {:else}
      {#each page.visible as message (message.id)}
        {@const mine = message.from_account === accountId}
        <!-- A sent bubble is a tinted container, so it hands its own `on-` role to everything
             inside it (MICA-102); a received one sits on the surface. -->
        <div
          class="flex px-4 py-1"
          class:justify-end={mine}
          data-testid="dm-message"
          data-message-id={message.id}
          data-mine={mine}
        >
          <div
            class="max-w-[80%] rounded-box px-3 py-2"
            class:bg-primary-container={mine}
            class:bg-surface-container={!mine}
          >
            {#if bubble}
              {@render bubble(message, mine)}
            {:else}
              <!-- Another player's text: rendered as text, never as markup. -->
              <p
                class="text-body-medium break-words whitespace-pre-wrap"
                class:text-on-primary-container={mine}
                class:text-on-surface={!mine}
              >
                {message.body}
              </p>
            {/if}
            <div class="mt-0.5 flex items-center gap-1">
              <p
                class="text-label-small"
                class:text-on-primary-container={mine}
                class:text-on-surface-variant={!mine}
              >
                {formatDate(message.created_at)}
              </p>
              {#if !mine && onreport}
                <ReportButton
                  subject={$t('ui.dmMessageNoun')}
                  size="mini"
                  onclick={() => onreport(message)}
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
    {placeholder}
    maxlength={bodyMax}
    busy={sending}
    onsend={() => void send()}
  >
    {#snippet above()}
      {#if failure}
        <p class="text-error text-body-small mb-1.5" role="alert" data-testid="dm-send-failed">
          {failure}
        </p>
      {/if}
      {#if emoji}
        <div class="mb-1.5">
          <EmojiPicker onselect={(picked: string) => (draft += picked)} />
        </div>
      {/if}
    {/snippet}
  </MessageBar>
</div>
