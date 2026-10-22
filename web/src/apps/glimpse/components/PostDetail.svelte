<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import {
    Avatar,
    EmptyState,
    formatDate,
    MessageBar,
    ReportDialog,
    Skeleton,
    useAppAction,
    useLocale,
    initialsOf
  } from '@mica/sdk';
  import type { GlimpseComment, GlimpsePost } from '@mica/shared/types';
  import {
    addComment,
    engagement,
    likes,
    loadComments,
    loadEngagement,
    loadLikes,
    myAccounts,
    removeComment,
    viewPost
  } from '../store';
  import PostCard from './PostCard.svelte';

  /** `mica_glimpse_comments.body` is a varchar(300), the contract's `max`. */
  const COMMENT_LIMIT = 300;

  /**
   * One post and its comments.
   *
   * Comments are newest first, the order `glimpse_comments:list` pages them in, with older ones
   * a tap away — so a comment just posted lands at the top, where the player is looking.
   *
   * **Who may remove a comment** is its author, or the owner of the post it sits under (an owner
   * decision): the button shows on a comment when either account is one of mine, and acts as
   * whichever one it is. The server checks both again; this only decides what to offer.
   */
  let {
    postId,
    version = 0,
    canEdit,
    onhandle,
    onlike,
    onedit,
    ondelete
  }: {
    postId: number;
    /** Bumped by the parent after it changes this post (a caption edit): re-read the post. */
    version?: number;
    canEdit: (post: GlimpsePost) => boolean;
    onhandle?: (handle: string) => void;
    onlike?: (post: GlimpsePost) => void;
    onedit?: (post: GlimpsePost) => void;
    ondelete?: (post: GlimpsePost) => void;
  } = $props();

  const { t } = useLocale();
  const { run, busy } = useAppAction('glimpse');

  let post = $state<GlimpsePost | null>(null);
  let missing = $state(false);
  let comments = $state<GlimpseComment[]>([]);
  let cursor = $state<number | null>(null);
  let loadingComments = $state(true);
  /** The last page asked for failed — not "no comments", which only a real answer can say. */
  let commentsFailed = $state(false);
  let draft = $state('');
  let reportingComment = $state<GlimpseComment | null>(null);

  const mineIds = $derived(new Set($myAccounts.map((account) => account.id)));
  const postIsMine = $derived(post !== null && mineIds.has(post.account_id));

  /** The account to remove `comment` as, or null when none of mine may. Author first. */
  const removerFor = (comment: GlimpseComment): number | null => {
    if (mineIds.has(comment.account_id)) return comment.account_id;
    if (post && mineIds.has(post.account_id)) return post.account_id;
    return null;
  };

  const loadPage = async (from: number | null) => {
    loadingComments = true;
    try {
      const reply = await loadComments(postId, from);
      comments = from === null ? reply.rows : [...comments, ...reply.rows];
      cursor = reply.nextCursor;
      commentsFailed = false;
    } catch (error) {
      commentsFailed = true;
      console.warn('micaOS Glimpse: could not load comments', error);
    } finally {
      loadingComments = false;
    }
  };

  const refresh = async () => {
    try {
      const found = await viewPost(postId);
      post = found;
      missing = found === null;
    } catch (error) {
      // Not "gone": a failed read keeps the skeleton, and reopening the post is the retry.
      console.warn('micaOS Glimpse: could not load this post', error);
      return;
    }
    if (post) {
      void loadEngagement([post.id]).catch((error) => {
        console.warn('micaOS Glimpse: could not load comment counts', error);
      });
      void loadLikes([post.id]);
    }
  };

  // Rendered unkeyed by the parent, so a new id changes props on one instance: reset by hand.
  $effect(() => {
    void postId;
    post = null;
    missing = false;
    comments = [];
    cursor = null;
    void refresh();
    void loadPage(null);
  });

  // An edit made from this screen: the post again, without dropping the comments under it.
  let seenVersion = untrack(() => version);
  $effect(() => {
    if (version === seenVersion) return;
    seenVersion = version;
    void refresh();
  });

  const send = async () => {
    const body = draft.trim();
    if (!body || !post) return;
    const target = post.id;
    // `run` answers whether the work succeeded, not what it returned, so the row is caught here.
    let created = null as GlimpseComment | null;
    const ok = await run(
      async () => {
        created = await addComment(target, body);
      },
      { title: $t('glimpse.title') }
    );
    if (ok && created) {
      comments = [created, ...comments];
      draft = '';
    }
  };

  const remove = async (comment: GlimpseComment) => {
    const actingAs = removerFor(comment);
    if (actingAs === null) return;
    const done = await run(() => removeComment(comment.post_id, comment.id, actingAs), {
      title: $t('glimpse.title'),
      success: $t('glimpse.commentRemoved')
    });
    if (done) comments = comments.filter((c) => c.id !== comment.id);
  };
</script>

<div class="flex min-h-0 flex-1 flex-col">
  {#if missing}
    <EmptyState
      title={$t('glimpse.postUnavailable')}
      description={$t('glimpse.postUnavailableHint')}
    />
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if post}
        <PostCard
          {post}
          mine={postIsMine}
          canEdit={canEdit(post)}
          likes={$likes[post.id]}
          stats={$engagement[post.id]}
          {onhandle}
          {onlike}
          {onedit}
          {ondelete}
        />
      {:else}
        <div class="p-4"><Skeleton count={1} height="h-64" /></div>
      {/if}

      <section aria-label={$t('glimpse.comments')} data-testid="glimpse-comments">
        {#if (loadingComments || commentsFailed) && comments.length === 0}
          <div class="p-4"><Skeleton count={2} height="h-10" /></div>
        {:else if comments.length === 0}
          <p class="text-on-surface-variant text-body-small p-4 text-center">
            {$t('glimpse.noComments')}
          </p>
        {:else}
          {#each comments as comment (comment.id)}
            {@const remover = removerFor(comment)}
            <div
              class="flex gap-2.5 px-3 py-2"
              data-testid="glimpse-comment"
              data-comment-id={comment.id}
            >
              <button
                type="button"
                class="shrink-0 cursor-pointer rounded-full"
                onclick={() => comment.handle && onhandle?.(comment.handle)}
                aria-label={$t('glimpse.profileOf', {
                  name: comment.display_name || comment.handle || ''
                })}
              >
                <Avatar
                  src={comment.avatar ?? undefined}
                  initials={initialsOf(comment.handle)}
                  size="w-7 h-7"
                  textClass="text-label-small"
                  showSilhouette={!comment.handle}
                />
              </button>
              <div class="min-w-0 flex-1">
                <p class="text-on-surface text-body-small break-words whitespace-pre-wrap">
                  <span class="font-semibold">{comment.handle ?? ''}</span>
                  {comment.body}
                </p>
                <div class="text-on-surface-variant text-label-small mt-0.5 flex gap-3">
                  <span>{formatDate(comment.created_at)}</span>
                  {#if remover !== null}
                    <button
                      type="button"
                      class="text-error cursor-pointer hover:underline"
                      disabled={$busy}
                      onclick={() => void remove(comment)}
                    >
                      {$t('glimpse.removeComment')}
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="cursor-pointer hover:underline"
                      onclick={() => (reportingComment = comment)}
                    >
                      {$t('glimpse.reportComment')}
                    </button>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
          {#if cursor !== null}
            <button
              type="button"
              class="text-primary text-body-small w-full cursor-pointer p-3 hover:underline"
              disabled={loadingComments}
              onclick={() => void loadPage(cursor)}
            >
              {$t('glimpse.olderComments')}
            </button>
          {/if}
        {/if}
      </section>
    </div>

    {#if post}
      <MessageBar
        bind:value={draft}
        placeholder={$t('glimpse.addComment')}
        maxlength={COMMENT_LIMIT}
        busy={$busy}
        onsend={() => void send()}
      />
    {/if}
  {/if}
</div>

{#if reportingComment}
  <ReportDialog
    targetTable="mica_glimpse_comments"
    targetId={reportingComment.id}
    appId="glimpse"
    onclose={() => (reportingComment = null)}
  />
{/if}
