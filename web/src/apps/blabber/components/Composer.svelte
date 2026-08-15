<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, CloseIcon, MediaThumb, PhotoIcon, PhotoPickerModal } from '@gphone/sdk';
  import type { MediaPreview } from '@shared/types';

  /** 280, matching `gphone_blabber.body`. The server enforces it from the same declaration. */
  const LIMIT = 280;

  /**
   * `placeholder` varies the prompt between the three things this composer does — post, reply,
   * fix a typo — and nothing else. It is **not** the knob for a different kind of composer: the
   * DM thread used to reach it with `placeholder="Message"` and inherited a **Post** button, a
   * 280 counter against a `varchar(500)` column, and "Posting as @x" inside a private
   * conversation with one other person. That caller is `DmComposer.svelte` now.
   */
  let {
    handle,
    placeholder = "What's happening?",
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
    onsubmit: (body: string, attachments?: { photo_id: number }[]) => void;
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
  const remaining = $derived(LIMIT - text.length);
  // A picture post needs no text: the same rule the server enforces in `create`.
  const canPost = $derived(
    (text.trim().length > 0 || attachments.length > 0) && remaining >= 0 && !busy
  );

  const submit = () => {
    onsubmit(
      text.trim(),
      attachments.length > 0 ? attachments.map((a) => ({ photo_id: a.photo_id })) : undefined
    );
  };
</script>

<div class="border-outline-variant border-b p-3">
  {#if handle}
    <p class="text-on-surface-variant mb-1.5 text-xs">
      Posting as <span class="text-primary">@{handle}</span>
    </p>
  {/if}

  <!-- maxlength as well as the counter: the server refuses an over-long body, and a player
       should meet the limit while typing rather than after tapping Post. -->
  <textarea
    bind:value={text}
    {placeholder}
    maxlength={LIMIT}
    rows="3"
    class="bg-surface-container text-on-surface placeholder-on-surface-variant w-full resize-none rounded-lg p-2.5 text-sm focus:outline-none"
  ></textarea>

  {#if attachments.length > 0}
    <div class="no-scrollbar mt-2 flex gap-2 overflow-x-auto p-1">
      {#each attachments as att (att.photo_id)}
        <div
          class="border-outline shadow-elevation-2 relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border"
        >
          <MediaThumb item={att.media} alt="Attachment" />
          <button
            type="button"
            class="text-on-surface bg-media-overlay absolute top-0 right-0 cursor-pointer rounded-bl-lg p-0.5 hover:bg-black"
            onclick={() => (attachments = attachments.filter((a) => a.photo_id !== att.photo_id))}
            aria-label="Remove attachment"
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
          class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors"
          onclick={() => (showPicker = true)}
          aria-label="Attach photo"
        >
          <PhotoIcon class="h-5 w-5" />
        </button>
      {/if}
      <span
        class="text-xs"
        class:text-on-surface-variant={remaining > 20}
        class:text-amber-400={remaining <= 20}
      >
        {remaining}
      </span>
    </div>
    <div class="flex gap-2">
      {#if oncancel}
        <Button variant="secondary" onclick={oncancel}>Cancel</Button>
      {/if}
      <Button disabled={!canPost} onclick={submit}>
        {busy ? '…' : 'Post'}
      </Button>
    </div>
  </div>
</div>

{#if showPicker}
  <PhotoPickerModal
    title="Select Photos"
    multiSelect={true}
    selectedIds={attachments.map((a) => a.photo_id)}
    onmultichange={(photoId, media) => {
      const existing = attachments.find((a) => a.photo_id === photoId);
      if (existing) {
        attachments = attachments.filter((a) => a.photo_id !== photoId);
      } else {
        attachments = [...attachments, { photo_id: photoId, media }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
