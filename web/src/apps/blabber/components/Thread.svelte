<script lang="ts">
  import { EmptyState, Skeleton, useBlabber } from '@gphone/sdk';
  import type { Blab } from '@shared/types';
  import BlabRow from './BlabRow.svelte';
  import Composer from './Composer.svelte';

  /**
   * One Blab and its direct replies.
   *
   * Replies nest through the same `reply_to` column, so "a reply's own thread" is this exact
   * component one level deeper — opening a reply pushes another Thread rather than needing a
   * different read or a recursive query. That is the whole reason a reply is a Blab rather than
   * its own table.
   */
  let {
    root,
    handle,
    busy = false,
    onhandle,
    onopen,
    onreply,
    onmouth,
    onlike
  }: {
    root: Blab;
    handle?: string;
    busy?: boolean;
    onhandle?: (handle: string) => void;
    onopen?: (blab: Blab) => void;
    onreply?: (parent: Blab, body: string) => Promise<void> | void;
    onmouth?: (blab: Blab) => void;
    onlike?: (blab: Blab) => void;
  } = $props();

  const { engagement, loadEngagement, loadThread } = useBlabber();

  let replies = $state<Blab[]>([]);
  let loading = $state(true);

  const refresh = async () => {
    loading = true;
    try {
      const page = await loadThread(root.id);
      replies = page.rows;
      // The root as well, so its own reply count moves when somebody replies here.
      await loadEngagement([root.id, ...page.rows.map((row) => row.id)]);
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    void root.id;
    replies = [];
    void refresh();
  });

  const submitReply = async (body: string) => {
    await onreply?.(root, body);
    await refresh();
  };
</script>

<div class="flex h-full flex-col">
  <div class="border-outline-variant border-b">
    <BlabRow
      blab={root}
      stats={$engagement[root.id]}
      {onhandle}
      onmouth={() => onmouth?.(root)}
      onlike={() => onlike?.(root)}
    />
  </div>

  <Composer {handle} placeholder="Post your reply" {busy} onsubmit={submitReply} />

  <div class="flex-1 overflow-y-auto">
    {#if loading && replies.length === 0}
      <div class="p-4"><Skeleton count={2} height="h-16" /></div>
    {:else if replies.length === 0}
      <EmptyState title="No replies yet" description="Say something back." />
    {:else}
      {#each replies as reply (reply.id)}
        <BlabRow
          blab={reply}
          stats={$engagement[reply.id]}
          {onhandle}
          {onopen}
          onreply={() => onopen?.(reply)}
          onmouth={() => onmouth?.(reply)}
          onlike={() => onlike?.(reply)}
        />
      {/each}
    {/if}
  </div>
</div>
