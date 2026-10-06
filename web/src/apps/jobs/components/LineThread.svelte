<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { EmptyState, PhotoIcon, Skeleton, formatTime, useLocale } from '@mica/sdk';
  import type { JobLineMessage } from '@mica/shared/types';

  /**
   * One player's thread with a job line, from the staff side (MICA-307).
   *
   * The caller's messages sit on the left and the line's answers on the right, whoever on the
   * line sent them: staff answer as the line, never as themselves, so the thread does not say
   * which colleague wrote what. A photo the caller attached is named, never shown — staff see
   * that one was sent, which is all the contract carries.
   */
  let {
    messages,
    loaded,
    hasOlder,
    loadingOlder,
    scrollRequest = 0,
    onloadolder
  }: {
    /** Oldest first. */
    messages: JobLineMessage[];
    loaded: boolean;
    /** The server holds an older page behind the loaded one. */
    hasOlder: boolean;
    loadingOlder: boolean;
    /**
     * Bumped by the app after the player's own reply lands: that one always scrolls into view,
     * wherever the reader was, the way Messages scrolls after a send.
     */
    scrollRequest?: number;
    onloadolder: () => void;
  } = $props();

  const { t } = useLocale();

  /**
   * Keep the newest message in view without yanking a reader who has scrolled up.
   *
   * The thread opens at the bottom, as Messages does (`scrollToBottom` in its index). After
   * that, a new newest row — a push from the caller or a colleague — follows it down only when
   * the reader was already within `NEAR_BOTTOM` px of the end before it arrived; someone
   * scrolled up reading older rows stays where they are. An older page loads *above* and never
   * changes the newest row, so it never scrolls. The player's own reply is `scrollRequest`.
   *
   * "Was near the bottom" has to be measured before the new row is in the DOM, which is what
   * `$effect.pre` is for; afterwards the new row has already pushed the end further away.
   */
  const NEAR_BOTTOM = 80;
  let scroller: HTMLDivElement | undefined = $state();
  let wasNearBottom = true;
  let shownNewest: number | null = null;
  /** The `scrollRequest` already acted on; the first value seen is the baseline, not a request. */
  let handledRequest: number | undefined;

  const toBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };

  $effect.pre(() => {
    void messages;
    if (!scroller) return;
    wasNearBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_BOTTOM;
  });

  $effect(() => {
    const newest = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (newest === shownNewest) return;
    const first = shownNewest === null;
    shownNewest = newest;
    if (newest !== null && (first || wasNearBottom)) toBottom();
  });

  $effect(() => {
    const request = scrollRequest;
    if (handledRequest === undefined || request === handledRequest) {
      handledRequest = request;
      return;
    }
    handledRequest = request;
    toBottom();
  });
</script>

<div
  bind:this={scroller}
  class="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-4"
  data-testid="line-thread"
>
  {#if !loaded}
    <Skeleton count={3} height="h-12" />
  {:else}
    {#if hasOlder}
      <div class="my-2 flex justify-center">
        <button
          type="button"
          class="border-primary bg-surface-container text-primary shadow-elevation-1 duration-short ease-standard text-body-small cursor-pointer rounded-box border px-3.5 py-1.5 transition-colors"
          disabled={loadingOlder}
          onclick={onloadolder}
        >
          {loadingOlder ? $t('jobs.loadingOlder') : $t('jobs.loadOlder')}
        </button>
      </div>
    {/if}

    {#each messages as msg (msg.id)}
      <div
        class="flex flex-col {msg.side === 'line' ? 'items-end' : 'items-start'}"
        data-testid="line-message"
        data-side={msg.side}
      >
        <div
          class="shadow-elevation-1 max-w-[85%] rounded-box px-4 py-2.5 {msg.side === 'line'
            ? 'bg-primary-container text-on-primary-container rounded-tr-xs'
            : 'bg-surface-container text-on-surface rounded-tl-xs'}"
        >
          {#if msg.has_attachments}
            <div class="text-label-small mb-1 flex items-center gap-1.5 opacity-80">
              <PhotoIcon class="size-icon-sm shrink-0" />
              <span>{$t('jobs.photoSent')}</span>
            </div>
          {/if}
          {#if msg.message}
            <p class="text-body-medium leading-relaxed whitespace-pre-wrap break-words">
              {msg.message}
            </p>
          {/if}
        </div>
        <span class="text-on-surface-variant text-label-small mt-0.5 px-1">
          {formatTime(msg.created_at)}
        </span>
      </div>
    {:else}
      <div class="mt-10">
        <EmptyState title={$t('jobs.threadEmpty')} />
      </div>
    {/each}
  {/if}
</div>
