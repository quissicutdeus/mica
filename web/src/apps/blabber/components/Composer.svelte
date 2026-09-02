<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { MAX_ATTACHMENTS } from '@gphone/shared/attachments';
  import { untrack } from 'svelte';
  import {
    Button,
    CloseIcon,
    MediaThumb,
    PhotoIcon,
    PhotoPickerModal,
    useLocale
  } from '@gphone/sdk';
  import type { MediaPreview } from '@gphone/shared/types';

  /** 280, matching `gphone_blabber.body`. The server enforces it from the same declaration. */
  const LIMIT = 280;

  const { t } = useLocale();

  /**
   * `placeholder` varies the prompt between the three things this composer does — post, reply,
   * fix a typo — and nothing else. It is **not** the knob for a different kind of composer: the
   * DM thread used to reach it with `placeholder="Message"` and inherited a **Post** button, a
   * 280 counter against a `varchar(500)` column, and "Posting as @x" inside a private
   * conversation with one other person. That caller is `DmComposer.svelte` now.
   */
  let {
    handle,
    placeholder = '',
    busy = false,
    initial = '',
    /**
     * False for editing an existing Blab. There is no route to add or remove an attachment on
     * a row that already exists — the edit window (§10) is framed as a typo fix, not a rewrite
     * of what was posted — so the attach affordance would offer a thing this composer cannot do.
     */
    allowAttachments = true,
    onsubmit,
    oncancel
  }: {
    handle?: string;
    placeholder?: string;
    busy?: boolean;
    initial?: string;
    allowAttachments?: boolean;
    /**
     * May return a promise, and this composer awaits it — that is what tells it the post
     * landed and the draft can be cleared. A caller that unmounts the composer instead
     * (`index.svelte` closes the overlay before posting) can keep returning `void`.
     */
    onsubmit: (body: string, attachments?: { photo_id: number }[]) => void | Promise<void>;
    oncancel?: () => void;
  } = $props();

  /**
   * Seeded from `initial` once, deliberately — `untrack` says so rather than leaving
   * `--fail-on-warnings` to guess.
   *
   * The parent mounts a fresh Composer when it switches between posting and editing, so "read
   * the prop at mount" is the whole requirement. Tracking it would fight the player: every
   * keystroke would be re-overwritten by the original body.
   */
  let text = $state(untrack(() => initial));
  let attachments = $state<{ photo_id: number; media: MediaPreview }[]>([]);
  let showPicker = $state(false);

  /**
   * A submit of this composer's own, in flight.
   *
   * Not the same thing as `busy`. `busy` is the app-level `useAppAction` flag, and the reply
   * path does not go through `run` — `BlabDetail.submitReply` calls `postBlab` directly — so
   * `busy` never rises for a reply and cannot gate one. This flag is what actually stops the
   * second tap (MICA-100).
   */
  let submitting = $state(false);

  const remaining = $derived(LIMIT - text.length);
  // A picture post needs no text: the same rule the server enforces in `create`.
  const canPost = $derived(
    (text.trim().length > 0 || attachments.length > 0) && remaining >= 0 && !busy && !submitting
  );

  /**
   * Clear on success, keep the draft on failure.
   *
   * The reply composer is mounted for the life of the thread — unlike the post composer, which
   * `index.svelte` unmounts on submit and so never had to clear itself. Leaving the text in
   * place after a successful reply meant a second tap of Post filed an identical duplicate
   * (MICA-100); clearing it unconditionally would instead throw away a player's words when
   * the send failed.
   */
  const submit = async () => {
    if (!canPost) return;
    submitting = true;
    try {
      await onsubmit(
        text.trim(),
        attachments.length > 0 ? attachments.map((a) => ({ photo_id: a.photo_id })) : undefined
      );
    } catch {
      // Swallowed rather than rethrown: this runs from an `onclick`, so a rejection here is an
      // unhandled one and reports nothing to anybody. The draft survives, which is the part the
      // player can act on. Surfacing the reason is `useAppAction`'s job, on the caller's side.
      return;
    } finally {
      submitting = false;
    }
    text = '';
    attachments = [];
  };
</script>

<div class="border-outline-variant border-b p-3">
  {#if handle}
    <p class="text-on-surface-variant text-body-small mb-1.5">
      {$t('blabber.postingAs')} <span class="text-primary">@{handle}</span>
    </p>
  {/if}

  <!-- maxlength as well as the counter: the server refuses an over-long body, and a player
       should meet the limit while typing rather than after tapping Post. -->
  <textarea
    bind:value={text}
    placeholder={placeholder || $t('blabber.whatsHappening')}
    maxlength={LIMIT}
    rows="3"
    class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full resize-none rounded-box p-2.5 focus:outline-none"
  ></textarea>

  {#if attachments.length > 0}
    <div class="no-scrollbar mt-2 flex gap-2 overflow-x-auto p-1">
      {#each attachments as att (att.photo_id)}
        <div
          class="border-outline shadow-elevation-2 relative h-14 w-14 shrink-0 overflow-hidden rounded-box border"
        >
          <MediaThumb item={att.media} alt={$t('blabber.attachment')} />
          <button
            type="button"
            class="text-on-surface bg-media-overlay absolute top-0 right-0 cursor-pointer rounded-bl-lg p-0.5 hover:bg-black"
            onclick={() => (attachments = attachments.filter((a) => a.photo_id !== att.photo_id))}
            aria-label={$t('blabber.removeAttachment')}
          >
            <CloseIcon class="h-3 w-3" />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="mt-2 flex items-center justify-between">
    <div class="flex items-center gap-2">
      {#if allowAttachments}
        <button
          type="button"
          class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary duration-short ease-standard flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors"
          onclick={() => (showPicker = true)}
          aria-label={$t('blabber.attachPhoto')}
        >
          <PhotoIcon class="size-icon-md" />
        </button>
      {/if}
      <span
        class="text-body-small"
        class:text-on-surface-variant={remaining > 20}
        class:text-amber-400={remaining <= 20}
      >
        {remaining}
      </span>
    </div>
    <div class="flex gap-2">
      {#if oncancel}
        <Button variant="secondary" onclick={oncancel}>{$t('blabber.cancel')}</Button>
      {/if}
      <Button disabled={!canPost} onclick={() => void submit()}>
        {busy || submitting ? '…' : $t('blabber.post')}
      </Button>
    </div>
  </div>
</div>

{#if showPicker}
  <PhotoPickerModal
    title={$t('blabber.selectPhotos')}
    multiSelect={true}
    selectedIds={attachments.map((a) => a.photo_id)}
    onmultichange={(photoId: number, media: MediaPreview) => {
      const existing = attachments.find((a) => a.photo_id === photoId);
      if (existing) {
        attachments = attachments.filter((a) => a.photo_id !== photoId);
      } else if (attachments.length < MAX_ATTACHMENTS) {
        // The server refuses an over-cap array outright rather than truncating it, so the
        // picker has to stop here or an ordinary player meets an error the composer never
        // warned them about (MICA-154).
        attachments = [...attachments, { photo_id: photoId, media }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
