<script lang="ts">
  import { EmptyState, Skeleton, usePagedList } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import type { Blab } from '@shared/types';
  import BlabRow from './BlabRow.svelte';
  import Composer from './Composer.svelte';

  /**
   * One Blab, flattened: the root, then every reply under it at any depth, in one screen.
   *
   * Replaces `Thread.svelte`, which let a tap on a reply push a new, identically-shaped screen
   * one level deeper — unbounded, and with no landing spot for a search result that is itself a
   * reply. `root_id` (server/services/Blabber.ts) is what makes "every reply at any depth" a
   * single query instead of a walk: see the design spec for why.
   *
   * A reply row here has no `onopen` — there is nowhere further to go. Tapping "Reply" on any
   * row, root included, retargets the one composer at the bottom rather than opening anything.
   */
  let {
    blabId,
    anchorId,
    handle,
    busy = false,
    onhandle,
    ontag,
    onmouth,
    onear
  }: {
    blabId: number;
    anchorId?: number;
    handle?: string;
    busy?: boolean;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onmouth?: (blab: Blab) => void;
    onear?: (blab: Blab) => void;
  } = $props();

  const { viewBlab, loadMoreReplies, engagement, loadEngagement, postBlab } = useBlabber();

  let root = $state<Blab | null>(null);
  let replies = $state<Blab[]>([]);
  let cursor = $state<number | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  /** Who the pinned composer targets — the root by default, or whichever row's Reply was tapped. */
  let replyTarget = $state<Blab | null>(null);

  /**
   * The scrolling wrapper the anchor row is found and centered within — scoped to this
   * component's own subtree rather than a global `document.querySelector`, so this cannot reach
   * outside a screen it does not own.
   */
  let container: HTMLDivElement | undefined = $state();
  /** Which anchor has already been scrolled to, so a later reactive update does not re-scroll. */
  let scrolledAnchorId: number | undefined;

  const refresh = async () => {
    loading = true;
    try {
      const reply = await viewBlab(blabId, anchorId ? { anchorId } : {});
      root = reply.root;
      missing = reply.root === null;
      replies = reply.replies;
      cursor = reply.nextCursor;
      replyTarget = reply.root;
      if (reply.root) {
        await loadEngagement([reply.root.id, ...reply.replies.map((r) => r.id)]);
      }
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    void blabId;
    void anchorId;
    root = null;
    replies = [];
    // `index.svelte` renders this component unkeyed — switching Blabs changes props on one
    // persistent instance rather than remounting — so the window has to be reset by hand.
    // Without this, opening a long thread after scrolling deep into another one reveals a
    // window sized from the previous Blab's `limit`, showing more replies than a fresh page
    // and asking `loadEngagement` for ids nobody scrolled to yet.
    page.reset();
    scrolledAnchorId = undefined;
    void refresh();
  });

  /**
   * Center the anchor row once it is actually present, and only once.
   *
   * `refresh` requests a page centered on `anchorId` (§ server `findFlattenedPage`), but the
   * row still has to reach the DOM before it can be scrolled to — this effect re-runs as
   * `replies` fills in and stops once `scrolledAnchorId` records that this anchor is done, so a
   * later reactive update (loading older replies, an engagement refresh) cannot re-scroll under
   * the player.
   */
  $effect(() => {
    if (anchorId === undefined || scrolledAnchorId === anchorId) return;
    const present = replies.some((reply) => reply.id === anchorId) || root?.id === anchorId;
    if (!present || !container) return;

    const node = container.querySelector(`[data-blab-id="${anchorId}"]`);
    if (!node) return;

    node.scrollIntoView({ block: 'center' });
    scrolledAnchorId = anchorId;
  });

  const page = usePagedList<Blab>({
    items: () => replies,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: async () => {
      if (cursor === null || root === null) return false;
      const more = await loadMoreReplies(root.id, cursor);
      cursor = more.nextCursor;
      if (more.rows.length === 0) return false;
      replies = [...replies, ...more.rows];
      await loadEngagement(more.rows.map((r) => r.id));
      return true;
    },
    hasMore: () => cursor !== null
  });

  const submitReply = async (body: string, attachments?: { photo_id: number }[]) => {
    if (!replyTarget) return;
    await postBlab(body, replyTarget.id, attachments);
    await refresh();
  };
</script>

<div class="flex h-full flex-col">
  {#if missing}
    <EmptyState
      title="Blab unavailable"
      description="This post has been deleted or is no longer visible."
    />
  {:else}
    <div class="border-outline-variant border-b">
      {#if root}
        <BlabRow
          blab={root}
          stats={$engagement[root.id]}
          {onhandle}
          {ontag}
          onmouth={() => root && onmouth?.(root)}
          onear={() => root && onear?.(root)}
          onreply={() => (replyTarget = root)}
        />
      {:else}
        <div class="p-4"><Skeleton count={1} height="h-16" /></div>
      {/if}
    </div>

    <Composer
      {handle}
      placeholder={replyTarget && root && replyTarget.id !== root.id
        ? `Reply to @${replyTarget.handle ?? ''}`
        : 'Post your reply'}
      {busy}
      onsubmit={submitReply}
    />

    <div class="flex-1 overflow-y-auto" onscroll={page.onScroll} bind:this={container}>
      {#if loading && replies.length === 0}
        <div class="p-4"><Skeleton count={2} height="h-16" /></div>
      {:else if replies.length === 0}
        <EmptyState title="No replies yet" description="Say something back." />
      {:else}
        {#each page.visible as reply (reply.id)}
          <div data-blab-id={reply.id}>
            <BlabRow
              blab={reply}
              stats={$engagement[reply.id]}
              {onhandle}
              {ontag}
              onreply={() => (replyTarget = reply)}
              onmouth={() => onmouth?.(reply)}
              onear={() => onear?.(reply)}
            />
          </div>
        {/each}
        {#if page.loading}
          <div class="p-4"><Skeleton count={2} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
