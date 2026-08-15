<script lang="ts">
  import { Avatar, formatDate, MediaThumb, ReportDialog } from '@gphone/sdk';
  import type { Blab, BlabEngagement } from '@shared/types';
  import BlabBody from './BlabBody.svelte';
  import BlabActions from './BlabActions.svelte';

  let {
    blab,
    editable = false,
    stats,
    onhandle,
    ontag,
    onedit,
    ondelete,
    onreply,
    onmouth,
    onear,
    onopen
  }: {
    blab: Blab;
    editable?: boolean;
    stats?: BlabEngagement;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onedit?: (blab: Blab) => void;
    ondelete?: (blab: Blab) => void;
    onreply?: (blab: Blab) => void;
    onmouth?: (blab: Blab) => void;
    onear?: (blab: Blab) => void;
    onopen?: (blab: Blab) => void;
  } = $props();

  /**
   * The row owns its own report dialog rather than taking a callback.
   *
   * There are four `BlabRow` call sites — the feed, the Following feed, a thread and a
   * profile — and threading a handler plus a dialog through each is four chances to wire
   * it differently or forget one. `editable` already means "this is mine", so the row
   * knows both whether to offer it and what to report.
   */
  let reporting = $state(false);

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

<article class="border-outline-variant flex gap-3 border-b px-4 py-3">
  <!-- The avatar goes to the profile, like the name beside it. A picture of somebody that does
       nothing when tapped is the one part of a row that looks like a link and is not. Named for
       where it goes rather than what it shows, so a screen reader hears a destination — and so it
       stays distinct from the name button, which announces the display name alone. -->
  {#if onhandle && blab.handle}
    <button
      type="button"
      class="duration-short ease-standard shrink-0 cursor-pointer rounded-full transition-transform hover:scale-105"
      onclick={() => blab.handle && onhandle(blab.handle)}
      aria-label="{blab.display_name || blab.handle}'s profile"
    >
      {@render avatar()}
    </button>
  {:else}
    {@render avatar()}
  {/if}

  <div class="min-w-0 flex-1">
    <div class="text-body-small flex items-baseline gap-1.5">
      <button
        type="button"
        class="text-on-surface truncate font-semibold hover:underline"
        onclick={() => blab.handle && onhandle?.(blab.handle)}
      >
        {blab.display_name || blab.handle}
      </button>
      <span class="text-on-surface-variant truncate">@{blab.handle}</span>
      <span class="text-outline">·</span>
      <span class="text-on-surface-variant shrink-0">{formatDate(blab.created_at)}</span>
      {#if edited}
        <span class="text-outline shrink-0 italic">edited</span>
      {/if}
    </div>

    {#if blab.mouth_of != null}
      <p class="text-label-small mt-0.5 flex items-center gap-1 text-emerald-400">
        Mouthed{#if blab.mouthed?.handle}&nbsp;@{blab.mouthed.handle}{/if}
      </p>
    {/if}

    {#if !isPlainMouth}
      <div class="mt-1">
        <BlabBody body={blab.body ?? ''} {onhandle} {ontag} />
      </div>
    {/if}

    {#if blab.attachments && blab.attachments.length > 0}
      <div class="mt-2 grid grid-cols-2 gap-1.5">
        {#each blab.attachments as attach (attach.id)}
          {#if attach.media}
            <div class="max-w-full overflow-hidden rounded-lg">
              <MediaThumb item={attach.media} fit="contain" alt="Attachment" />
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- The Blab being repeated, quoted inline. Not interactive: nesting the action bar inside a
         row's action bar is where a button ends up inside a button. -->
    {#if blab.mouthed}
      <div class="border-outline-variant mt-2 rounded-lg border p-2">
        <p class="text-on-surface-variant text-label-small">
          {blab.mouthed.display_name || blab.mouthed.handle}
          <span class="text-outline">@{blab.mouthed.handle}</span>
        </p>
        <BlabBody body={blab.mouthed.body ?? ''} {onhandle} {ontag} />
      </div>
    {/if}

    <BlabActions
      {stats}
      onreply={() => onreply?.(blab)}
      onmouth={() => onmouth?.(blab)}
      onear={() => onear?.(blab)}
      onreport={editable ? undefined : () => (reporting = true)}
    />

    <!-- A separate affordance rather than wrapping the body: BlabBody renders mention buttons,
         and a button inside a button is invalid HTML -- the outer one absorbs the inner in the
         accessibility tree, so the mention stops being reachable on its own. -->
    {#if onopen && (stats?.replies ?? 0) > 0}
      <button
        type="button"
        class="text-primary text-body-small mt-1 hover:underline"
        onclick={() => onopen?.(blab)}
      >
        View thread
      </button>
    {/if}

    {#if editable}
      <div class="text-body-small mt-2 flex gap-3">
        <button type="button" class="text-primary hover:underline" onclick={() => onedit?.(blab)}>
          Edit
        </button>
        <button type="button" class="text-error hover:underline" onclick={() => ondelete?.(blab)}>
          Delete
        </button>
      </div>
    {/if}
  </div>
</article>

{#if reporting}
  <ReportDialog
    targetTable="gphone_blabber"
    targetId={blab.id}
    appId="blabber"
    onclose={() => (reporting = false)}
  />
{/if}
