<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Avatar, formatDate, ReportDialog, useLocale } from '@mica/sdk';
  import type { GlimpseEngagement, GlimpsePost, ReactionSummary } from '@mica/shared/types';
  import { LIKE } from '../store';
  import Carousel from './Carousel.svelte';

  /**
   * One post: who, the photos, ❤️ and the comment count, then the caption.
   *
   * The card owns its report dialog, as Blabber's row does — every call site would otherwise
   * have to thread a handler and a dialog through. Report lives behind "•••" on somebody else's
   * post; on your own the same menu holds Edit caption and Delete, which are what you reach for
   * there, and reporting yourself is refused server-side anyway.
   */
  let {
    post,
    mine = false,
    likes,
    stats,
    canEdit = false,
    onhandle,
    onlike,
    onopen,
    onedit,
    ondelete
  }: {
    post: GlimpsePost;
    /** Posted by one of my accounts. The server decides for real. */
    mine?: boolean;
    likes?: ReactionSummary;
    stats?: GlimpseEngagement;
    /** Mine, and still inside the caption edit window. */
    canEdit?: boolean;
    onhandle?: (handle: string) => void;
    onlike?: (post: GlimpsePost) => void;
    /** Open the post's own screen, where its comments are. Absent when already on it. */
    onopen?: (post: GlimpsePost) => void;
    onedit?: (post: GlimpsePost) => void;
    ondelete?: (post: GlimpsePost) => void;
  } = $props();

  const { t } = useLocale();

  let reporting = $state(false);
  let overflowOpen = $state(false);

  const liked = $derived(likes?.mine.includes(LIKE) ?? false);
  const likeCount = $derived(likes?.counts[LIKE] ?? 0);
  const commentCount = $derived(stats?.comments ?? 0);
  const author = $derived(post.display_name || post.handle || '');

  /** `updated_at > created_at`, derived, never stored — the row already knows. */
  const edited = $derived(
    new Date(post.updated_at).getTime() - new Date(post.created_at).getTime() > 1000
  );

  /** Never an empty menu: on my own post it opens only when it holds something. */
  const hasOverflow = $derived(!mine || Boolean(ondelete) || (canEdit && Boolean(onedit)));
</script>

{#snippet avatar()}
  <Avatar
    src={post.avatar ?? undefined}
    initials={(post.handle ?? '?').slice(0, 2).toUpperCase()}
    size="w-8 h-8"
    textClass="text-label-small"
    showSilhouette={!post.handle}
  />
{/snippet}

<article
  class="border-outline-variant border-b pb-3"
  data-testid="glimpse-post"
  data-post-id={post.id}
  aria-label={$t('glimpse.postBy', { handle: post.handle ?? '' })}
>
  <header class="flex items-center gap-2.5 px-3 py-2">
    {#if onhandle && post.handle}
      <button
        type="button"
        class="duration-short ease-standard shrink-0 cursor-pointer rounded-full transition-transform hover:scale-105"
        onclick={() => post.handle && onhandle(post.handle)}
        aria-label={$t('glimpse.profileOf', { name: author })}
      >
        {@render avatar()}
      </button>
    {:else}
      {@render avatar()}
    {/if}

    <div class="min-w-0 flex-1">
      <button
        type="button"
        class="text-on-surface text-body-small block max-w-full truncate font-semibold hover:underline"
        onclick={() => post.handle && onhandle?.(post.handle)}
      >
        {post.handle ?? ''}
      </button>
      <p class="text-on-surface-variant text-label-small">
        {formatDate(post.created_at)}{#if edited}
          · <span class="italic">{$t('glimpse.edited')}</span>{/if}
      </p>
    </div>

    {#if hasOverflow}
      <!-- Dismissed when focus leaves the wrapper, as Blabber's row is: the card renders inside
           a scroll region, where an `inset-0` scrim would size to the content, not the screen. -->
      <span
        class="relative"
        onfocusout={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            overflowOpen = false;
          }
        }}
      >
        <button
          type="button"
          class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface focus-visible:ring-focus-ring duration-short ease-standard flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none"
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          aria-label={$t('glimpse.moreActions')}
          title={$t('glimpse.moreActions')}
          onclick={() => (overflowOpen = !overflowOpen)}
        >
          <svg class="size-icon-sm" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="19" cy="12" r="1.75" />
          </svg>
        </button>

        {#if overflowOpen}
          <div
            role="menu"
            class="animate-in fade-in border-outline-variant bg-surface shadow-elevation-4 duration-short ease-standard absolute top-full right-0 z-40 mt-1 w-48 overflow-hidden rounded-box border"
          >
            {#if mine}
              {#if canEdit && onedit}
                <button
                  type="button"
                  role="menuitem"
                  class="text-on-surface hover:bg-surface-container duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
                  onclick={() => {
                    overflowOpen = false;
                    onedit(post);
                  }}
                >
                  {$t('glimpse.editCaption')}
                </button>
              {/if}
              {#if ondelete}
                <button
                  type="button"
                  role="menuitem"
                  class="text-error hover:bg-surface-container duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
                  onclick={() => {
                    overflowOpen = false;
                    ondelete(post);
                  }}
                >
                  {$t('glimpse.deletePost')}
                </button>
              {/if}
            {:else}
              <button
                type="button"
                role="menuitem"
                class="text-on-surface hover:bg-surface-container hover:text-error duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
                onclick={() => {
                  overflowOpen = false;
                  reporting = true;
                }}
              >
                {$t('glimpse.reportPost')}
              </button>
            {/if}
          </div>
        {/if}
      </span>
    {/if}
  </header>

  <Carousel attachments={post.attachments} />

  <div class="text-on-surface-variant text-body-small flex items-center gap-4 px-3 pt-2">
    <button
      type="button"
      class="hover:text-error duration-short ease-standard flex cursor-pointer items-center gap-1.5 transition-colors"
      class:text-error={liked}
      aria-label={liked ? $t('glimpse.unlike') : $t('glimpse.like')}
      aria-pressed={liked}
      data-testid="glimpse-like"
      onclick={() => onlike?.(post)}
    >
      <svg
        class="size-icon-md"
        viewBox="0 0 24 24"
        fill={liked ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 20s-7-4.35-7-9.5A4.5 4.5 0 0 1 12 7.8 4.5 4.5 0 0 1 19 10.5c0 5.15-7 9.5-7 9.5Z"
        />
      </svg>
      <span data-testid="glimpse-like-count">{likeCount}</span>
    </button>

    <button
      type="button"
      class="hover:text-primary duration-short ease-standard flex cursor-pointer items-center gap-1.5 transition-colors disabled:cursor-default"
      aria-label={$t('glimpse.comments')}
      disabled={!onopen}
      onclick={() => onopen?.(post)}
    >
      <svg
        class="size-icon-md"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M8 10.5h8M8 14h5m-5 6.5 3-3h5.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3h-9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3H8v3Z"
        />
      </svg>
      <span data-testid="glimpse-comment-count">{commentCount}</span>
    </button>
  </div>

  {#if post.caption}
    <!-- Plain text, never `{@html}`: a caption is player content (§7). -->
    <p class="text-on-surface text-body-small px-3 pt-1.5 break-words whitespace-pre-wrap">
      <span class="font-semibold">{post.handle ?? ''}</span>
      {post.caption}
    </p>
  {/if}

  {#if onopen && commentCount > 0}
    <button
      type="button"
      class="text-on-surface-variant text-body-small cursor-pointer px-3 pt-1 hover:underline"
      onclick={() => onopen(post)}
    >
      {$t('glimpse.viewComments', { count: commentCount })}
    </button>
  {/if}
</article>

{#if reporting}
  <ReportDialog
    targetTable="mica_glimpse"
    targetId={post.id}
    appId="glimpse"
    onclose={() => (reporting = false)}
  />
{/if}
