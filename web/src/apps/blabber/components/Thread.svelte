<script lang="ts">
  import { EmptyState, Skeleton } from '@gphone/sdk';
  import { useBlabber } from '../store';
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

  const { engagement, loadEngagement, loadThread, loadBlab } = useBlabber();

  let replies = $state<Blab[]>([]);
  let loading = $state(true);
  /**
   * The root as the server knows it, which is not always what was passed in.
   *
   * A deep link names an id and nothing else, so `index.svelte` opens a thread around a
   * `{ id } as Blab` stub — and this component rendered that stub directly, which is why a
   * mention tapped from the shade, its toast, or the notifications tab arrived at a thread whose
   * replies loaded above a blank post. `created_at` is framework-supplied and present on every
   * real row, so its absence is the tell that the caller had only an id.
   */
  let rootBlab = $state<Blab | null>(null);
  /** A link can outlive the row it names — deleted, or moderated out of every read. */
  let missing = $state(false);

  const refresh = async () => {
    loading = true;
    try {
      const full = root.created_at ? root : await loadBlab(root.id);
      rootBlab = full;
      missing = full === null;

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
  {#if missing}
    <!-- A link outliving its post is an ordinary thing to tap, so it gets an answer rather than
         a blank row: the reply composer goes too, since there is nothing left to reply to. -->
    <EmptyState
      title="Blab unavailable"
      description="This post has been deleted or is no longer visible."
    />
  {:else}
    <div class="border-outline-variant border-b">
      {#if rootBlab}
        <BlabRow
          blab={rootBlab}
          stats={$engagement[rootBlab.id]}
          {onhandle}
          onmouth={() => rootBlab && onmouth?.(rootBlab)}
          onlike={() => rootBlab && onlike?.(rootBlab)}
        />
      {:else}
        <div class="p-4"><Skeleton count={1} height="h-16" /></div>
      {/if}
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
  {/if}
</div>
