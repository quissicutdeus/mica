<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Avatar, formatDate, MediaThumb, ReportDialog } from '@gphone/sdk';
  import type { Blab, BlabEngagement } from '@gphone/shared/types';
  import BlabBody from './BlabBody.svelte';
  import BlabActions from './BlabActions.svelte';

  let {
    blab,
    editable = false,
    menu = false,
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
    /**
     * Offer the "•••" overflow, which is where Report lives (MICA-97).
     *
     * False in the feed, on a profile and in search results — a list you are scrolling past.
     * True in `BlabDetail`, the screen you reach by stopping on one post. Report was previously
     * a filled flag in every row's action bar, larger than reply/mouth/ear beside it, which made
     * the least-used action the most prominent thing on every post a player scrolled past.
     */
    menu?: boolean;
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

  /** Whether this row's "•••" menu is open. */
  let overflowOpen = $state(false);

  /**
   * Nothing to put in the menu on your own post, so no menu.
   *
   * Report is its only item, and reporting yourself is not moderation — the server refuses it,
   * and an affordance that always fails is worse than none. Edit and Delete stay where they
   * are, as labelled text under the row: they are the two things a player actually reaches for
   * on their own post, and burying them behind a menu to keep company with Report would cost
   * more than it saves.
   */
  const hasOverflow = $derived(menu && !editable);

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
      <span class="text-on-surface-variant">·</span>
      <span class="text-on-surface-variant shrink-0">{formatDate(blab.created_at)}</span>
      {#if edited}
        <span class="text-on-surface-variant shrink-0 italic">edited</span>
      {/if}

      {#if hasOverflow}
        <!-- Dismissed on focus leaving the wrapper rather than with a full-screen scrim.
             `BlabRow` renders deep inside `Screen`'s scroll region, so an `inset-0` scrim would
             size to the scrolled content rather than the screen and cover only part of it. A
             mousedown on any other element moves focus out of this subtree, which is the same
             gesture, and it costs nothing on the keyboard path. -->
        <span
          class="relative ml-auto self-start"
          onfocusout={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              overflowOpen = false;
            }
          }}
        >
          <button
            type="button"
            class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface focus-visible:ring-focus-ring duration-short ease-standard flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            aria-label="More actions"
            title="More actions"
            onclick={() => (overflowOpen = !overflowOpen)}
          >
            <!-- Drawn here rather than added to `sdk/ui/icons`: the three action glyphs in
                 `BlabActions` are inline for the same reason, and one add-on wanting a "•••"
                 is not yet an argument for a shared icon. -->
            <svg class="size-icon-sm" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.75" />
              <circle cx="12" cy="12" r="1.75" />
              <circle cx="19" cy="12" r="1.75" />
            </svg>
          </button>

          {#if overflowOpen}
            <div
              role="menu"
              class="animate-in fade-in border-outline-variant bg-surface shadow-elevation-4 duration-short ease-standard absolute top-full right-0 z-40 mt-1 w-40 overflow-hidden rounded-box border"
            >
              <button
                type="button"
                role="menuitem"
                class="text-on-surface hover:bg-surface-container hover:text-error duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
                onclick={() => {
                  overflowOpen = false;
                  reporting = true;
                }}
              >
                Report post
              </button>
            </div>
          {/if}
        </span>
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
            <div class="max-w-full overflow-hidden rounded-box">
              <MediaThumb item={attach.media} fit="contain" alt="Attachment" />
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- The Blab being repeated, quoted inline. Not interactive: nesting the action bar inside a
         row's action bar is where a button ends up inside a button. -->
    {#if blab.mouthed}
      <div class="border-outline-variant mt-2 rounded-box border p-2">
        <p class="text-on-surface-variant text-label-small">
          {blab.mouthed.display_name || blab.mouthed.handle}
          <span class="text-on-surface-variant">@{blab.mouthed.handle}</span>
        </p>
        <BlabBody body={blab.mouthed.body ?? ''} {onhandle} {ontag} />
      </div>
    {/if}

    <BlabActions
      {stats}
      onreply={() => onreply?.(blab)}
      onmouth={() => onmouth?.(blab)}
      onear={() => onear?.(blab)}
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
