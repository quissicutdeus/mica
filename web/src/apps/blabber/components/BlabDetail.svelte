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
    onmouth,
    onlike
  }: {
    blabId: number;
    anchorId?: number;
    handle?: string;
    busy?: boolean;
    onhandle?: (handle: string) => void;
    onmouth?: (blab: Blab) => void;
    onlike?: (blab: Blab) => void;
  } = $props();

  const { viewBlab, loadMoreReplies, engagement, loadEngagement, postBlab } = useBlabber();

  let root = $state<Blab | null>(null);
  let replies = $state<Blab[]>([]);
  let cursor = $state<number | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  /** Who the pinned composer targets — the root by default, or whichever row's Reply was tapped. */
  let replyTarget = $state<Blab | null>(null);

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
    void refresh();
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

  const submitReply = async (body: string) => {
    if (!replyTarget) return;
    await postBlab(body, replyTarget.id);
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
          onmouth={() => root && onmouth?.(root)}
          onlike={() => root && onlike?.(root)}
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

    <div class="flex-1 overflow-y-auto" onscroll={page.onScroll}>
      {#if loading && replies.length === 0}
        <div class="p-4"><Skeleton count={2} height="h-16" /></div>
      {:else if replies.length === 0}
        <EmptyState title="No replies yet" description="Say something back." />
      {:else}
        {#each page.visible as reply (reply.id)}
          <BlabRow
            blab={reply}
            stats={$engagement[reply.id]}
            {onhandle}
            onreply={() => (replyTarget = reply)}
            onmouth={() => onmouth?.(reply)}
            onlike={() => onlike?.(reply)}
          />
        {/each}
        {#if page.loading}
          <div class="p-4"><Skeleton count={2} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
