<script lang="ts">
  import { Avatar, formatDate } from '@gphone/sdk';
  import type { Blab, BlabEngagement } from '@shared/types';
  import BlabBody from './BlabBody.svelte';
  import BlabActions from './BlabActions.svelte';

  let {
    blab,
    editable = false,
    stats,
    onhandle,
    onedit,
    ondelete,
    onreply,
    onmouth,
    onlike,
    onopen
  }: {
    blab: Blab;
    editable?: boolean;
    stats?: BlabEngagement;
    onhandle?: (handle: string) => void;
    onedit?: (blab: Blab) => void;
    ondelete?: (blab: Blab) => void;
    onreply?: (blab: Blab) => void;
    onmouth?: (blab: Blab) => void;
    onlike?: (blab: Blab) => void;
    onopen?: (blab: Blab) => void;
  } = $props();

  /** A mouth with no body of its own is a plain repeat; with one it is a quote. */
  const isPlainMouth = $derived(blab.mouth_of != null && !blab.body);

  /**
   * `updated_at > created_at` — derived, never stored.
   *
   * Both columns stamp identically on insert and `updated_at` carries
   * `ON UPDATE CURRENT_TIMESTAMP`, so the row already knows. An `is_edited` column would be a
   * second copy of a fact free to drift from the first.
   */
  const edited = $derived(
    new Date(blab.updated_at).getTime() - new Date(blab.created_at).getTime() > 1000
  );
</script>

{#snippet avatar()}
  <Avatar
    src={blab.avatar ?? undefined}
    initials={(blab.handle ?? '?').slice(0, 2).toUpperCase()}
    size="w-9 h-9"
    showSilhouette={!blab.handle}
  />
{/snippet}

<article class="flex gap-3 border-b border-gray-800 px-4 py-3">
  <!-- The avatar goes to the profile, like the name beside it. A picture of somebody that does
       nothing when tapped is the one part of a row that looks like a link and is not. Named for
       where it goes rather than what it shows, so a screen reader hears a destination — and so it
       stays distinct from the name button, which announces the display name alone. -->
  {#if onhandle && blab.handle}
    <button
      type="button"
      class="shrink-0 cursor-pointer rounded-full transition-transform hover:scale-105"
      onclick={() => blab.handle && onhandle(blab.handle)}
      aria-label="{blab.display_name || blab.handle}'s profile"
    >
      {@render avatar()}
    </button>
  {:else}
    {@render avatar()}
  {/if}

  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-1.5 text-xs">
      <button
        type="button"
        class="truncate font-semibold text-white hover:underline"
        onclick={() => blab.handle && onhandle?.(blab.handle)}
      >
        {blab.display_name || blab.handle}
      </button>
      <span class="truncate text-gray-500">@{blab.handle}</span>
      <span class="text-gray-600">·</span>
      <span class="shrink-0 text-gray-500">{formatDate(blab.created_at)}</span>
      {#if edited}
        <span class="shrink-0 text-gray-600 italic">edited</span>
      {/if}
    </div>

    {#if blab.mouth_of != null}
      <p class="mt-0.5 flex items-center gap-1 text-[11px] text-emerald-400">
        Mouthed{#if blab.mouthed?.handle}&nbsp;@{blab.mouthed.handle}{/if}
      </p>
    {/if}

    {#if !isPlainMouth}
      <div class="mt-1">
        <BlabBody body={blab.body ?? ''} {onhandle} />
      </div>
    {/if}

    <!-- The Blab being repeated, quoted inline. Not interactive: nesting the action bar inside a
         row's action bar is where a button ends up inside a button. -->
    {#if blab.mouthed}
      <div class="mt-2 rounded-lg border border-gray-700 p-2">
        <p class="text-[11px] text-gray-500">
          {blab.mouthed.display_name || blab.mouthed.handle}
          <span class="text-gray-600">@{blab.mouthed.handle}</span>
        </p>
        <BlabBody body={blab.mouthed.body ?? ''} {onhandle} />
      </div>
    {/if}

    <BlabActions
      {stats}
      onreply={() => onreply?.(blab)}
      onmouth={() => onmouth?.(blab)}
      onlike={() => onlike?.(blab)}
    />

    <!-- A separate affordance rather than wrapping the body: BlabBody renders mention buttons,
         and a button inside a button is invalid HTML -- the outer one absorbs the inner in the
         accessibility tree, so the mention stops being reachable on its own. -->
    {#if onopen && (stats?.replies ?? 0) > 0}
      <button
        type="button"
        class="mt-1 text-xs text-sky-400 hover:underline"
        onclick={() => onopen?.(blab)}
      >
        View thread
      </button>
    {/if}

    {#if editable}
      <div class="mt-2 flex gap-3 text-xs">
        <button type="button" class="text-sky-400 hover:underline" onclick={() => onedit?.(blab)}>
          Edit
        </button>
        <button type="button" class="text-red-400 hover:underline" onclick={() => ondelete?.(blab)}>
          Delete
        </button>
      </div>
    {/if}
  </div>
</article>
