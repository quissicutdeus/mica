<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '@gphone/sdk';

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
    onsubmit,
    oncancel
  }: {
    handle?: string;
    placeholder?: string;
    busy?: boolean;
    initial?: string;
    onsubmit: (body: string) => void;
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
  const remaining = $derived(LIMIT - text.length);
  const canPost = $derived(text.trim().length > 0 && remaining >= 0 && !busy);
</script>

<div class="border-b border-gray-800 p-3">
  {#if handle}
    <p class="mb-1.5 text-xs text-gray-500">
      Posting as <span class="text-sky-400">@{handle}</span>
    </p>
  {/if}

  <!-- maxlength as well as the counter: the server refuses an over-long body, and a player
       should meet the limit while typing rather than after tapping Post. -->
  <textarea
    bind:value={text}
    {placeholder}
    maxlength={LIMIT}
    rows="3"
    class="w-full resize-none rounded-lg bg-gray-800 p-2.5 text-sm text-white placeholder-gray-500 focus:outline-none"
  ></textarea>

  <div class="mt-2 flex items-center justify-between">
    <span
      class="text-xs"
      class:text-gray-500={remaining > 20}
      class:text-amber-400={remaining <= 20}
    >
      {remaining}
    </span>
    <div class="flex gap-2">
      {#if oncancel}
        <Button variant="secondary" onclick={oncancel}>Cancel</Button>
      {/if}
      <Button disabled={!canPost} onclick={() => onsubmit(text.trim())}>
        {busy ? '…' : 'Post'}
      </Button>
    </div>
  </div>
</div>
