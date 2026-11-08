<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Avatar,
    EmptyState,
    ListItem,
    Skeleton,
    StarIcon,
    useLocale,
    type Contact
  } from '@mica/sdk';

  const { t } = useLocale();

  /**
   * The contact list: favourites first, then everyone else.
   *
   * The two groups are one component because they are one scroll region with one empty
   * state — splitting them would need a parent to own the "neither has anything" case.
   */
  let {
    favorites,
    others,
    total,
    loaded,
    query,
    onselect
  }: {
    favorites: Contact[];
    others: Contact[];
    /** Both groups combined, so the empty state knows the difference between no
     *  contacts and no matches. */
    total: number;
    loaded: boolean;
    query: string;
    onselect: (contact: Contact) => void;
  } = $props();

  /**
   * MICA-446: only the rows near the viewport are in the DOM.
   *
   * Building every row's DOM at once — a hundred `ListItem`s, each with an `Avatar` — was a
   * single 400-545 ms task at 4x CPU on every mount, and it landed inside the open animation.
   * `content-visibility: auto` was measured first and did not help: it skips style and
   * layout for a row off screen, but the row's nodes are still created, and creating them was
   * the cost.
   *
   * Each group keeps its own section, sticky header and divider container; only the rows
   * between two spacers change. A spacer stands in for the rows above and below the window
   * at the measured pitch, so the scroll height — and the sticky headers, which stick within
   * their section — are what the whole list would give. Rows are fixed-height (`truncate`
   * keeps a name to one line), so one measured pitch places every row.
   */
  /** Rows rendered past each edge of the viewport, so a fast flick does not show a gap. */
  const OVERSCAN = 6;
  /** A row's height plus its 1px divider until a real pair of rows is measured. */
  const FALLBACK_PITCH = 73;
  /** The phone's layout height (`shared/devices.ts`), until the scroller is measured. */
  const FALLBACK_VIEWPORT = 850;

  let scroller: HTMLDivElement | undefined = $state();
  let favoritesHeaderEl: HTMLDivElement | undefined = $state();
  let othersHeaderEl: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let clientHeight = $state(0);
  let favoritesHeader = $state(0);
  let othersHeader = $state(0);
  let pitch = $state(FALLBACK_PITCH);

  const viewport = $derived(clientHeight || FALLBACK_VIEWPORT);

  /** Where a group's rows begin, measured from the top of the scroll content. */
  const favoritesRowsTop = $derived(favoritesHeader);
  const othersRowsTop = $derived(
    (favorites.length > 0 ? favoritesHeader + favorites.length * pitch - 1 : 0) + othersHeader
  );

  const windowStart = (rowsTop: number, count: number) =>
    Math.min(count, Math.max(0, Math.floor((scrollTop - rowsTop) / pitch) - OVERSCAN));
  const windowEnd = (rowsTop: number, count: number) =>
    Math.min(count, Math.max(0, Math.ceil((scrollTop + viewport - rowsTop) / pitch) + OVERSCAN));

  // Separate primitives, so a scroll that moves no window boundary changes nothing below.
  const favoritesStart = $derived(windowStart(favoritesRowsTop, favorites.length));
  const favoritesEnd = $derived(
    Math.max(favoritesStart, windowEnd(favoritesRowsTop, favorites.length))
  );
  const othersStart = $derived(windowStart(othersRowsTop, others.length));
  const othersEnd = $derived(Math.max(othersStart, windowEnd(othersRowsTop, others.length)));

  const favoritesShown = $derived(favorites.slice(favoritesStart, favoritesEnd));
  const othersShown = $derived(others.slice(othersStart, othersEnd));

  /**
   * Measured after every render rather than bound: `bind:clientHeight` and
   * `bind:offsetHeight` ride on a `ResizeObserver`, which jsdom lacks, so every suite that
   * renders Contacts would need a stub. The phone's size does not change under a mounted
   * app, and the rows only change on a render, so this is when the numbers can move.
   *
   * The pitch comes from two neighbouring rows. `offsetTop` and `offsetHeight` are layout
   * pixels, so the Settings > Display zoom (a `transform` on the frame) does not skew them
   * the way a bounding rectangle would.
   */
  $effect(() => {
    void favoritesShown;
    void othersShown;
    if (!scroller) return;
    if (scroller.clientHeight > 0) clientHeight = scroller.clientHeight;
    favoritesHeader = favoritesHeaderEl?.offsetHeight ?? 0;
    othersHeader = othersHeaderEl?.offsetHeight ?? 0;
    for (const group of scroller.querySelectorAll<HTMLElement>('[data-contact-rows]')) {
      const first = group.children[0] as HTMLElement | undefined;
      const second = group.children[1] as HTMLElement | undefined;
      if (!first || !second) continue;
      const measured = second.offsetTop - first.offsetTop;
      if (measured > 0 && Math.abs(measured - pitch) > 0.5) pitch = measured;
      break;
    }
  });

  /**
   * Read on `scroll`, and on `focusin` as well: focusing a row scrolls it into view at once,
   * but the `scroll` event for that waits for the next frame, so a held Tab key could reach
   * the window's last row before the window had moved and step out of the list.
   */
  const readScroll = () => {
    if (scroller) scrollTop = scroller.scrollTop;
  };

  /**
   * A search shrinks the list, and the browser clamps `scrollTop` to the shorter content;
   * read it back rather than trust that a scroll event reports the clamp.
   */
  $effect(() => {
    void total;
    if (scroller) scrollTop = scroller.scrollTop;
  });
</script>

{#snippet contactItem(contact: Contact)}
  <ListItem onclick={() => onselect(contact)}>
    <div class="mr-4 shrink-0">
      <Avatar
        src={contact.avatar}
        name="{contact.firstname} {contact.lastname ?? ''}"
        bgClass="bg-surface-container border border-outline-variant"
      />
    </div>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex items-center">
        <span class="truncate font-medium">
          {contact.firstname}
          {contact.lastname || ''}
        </span>
        {#if contact.favorite}
          <StarIcon class="size-icon-sm ml-1.5 shrink-0 text-yellow-400" />
        {/if}
      </div>
      <span class="text-on-surface-variant text-body-small">{contact.phone}</span>
    </div>
  </ListItem>
{/snippet}

<div class="overflow-y-auto" bind:this={scroller} onscroll={readScroll} onfocusin={readScroll}>
  {#if favorites.length > 0}
    <div>
      <div
        class="bg-surface-container border-outline-variant text-on-surface-variant text-body-small sticky top-0 z-10 border-b px-4 py-1 tracking-wider uppercase"
        bind:this={favoritesHeaderEl}
      >
        {$t('contacts.favorites')}
      </div>
      <div style:height="{favoritesStart * pitch}px"></div>
      <div class="divide-outline-variant divide-y" data-contact-rows>
        {#each favoritesShown as contact (contact.id)}
          {@render contactItem(contact)}
        {/each}
      </div>
      <div style:height="{(favorites.length - favoritesEnd) * pitch}px"></div>
    </div>
  {/if}

  {#if others.length > 0}
    <div>
      <div
        class="bg-surface-container border-outline-variant text-on-surface-variant text-body-small sticky top-0 z-10 border-b px-4 py-1 tracking-wider uppercase"
        bind:this={othersHeaderEl}
      >
        {$t('contacts.title')}
      </div>
      <div style:height="{othersStart * pitch}px"></div>
      <div class="divide-outline-variant divide-y" data-contact-rows>
        {#each othersShown as contact (contact.id)}
          {@render contactItem(contact)}
        {/each}
      </div>
      <div style:height="{(others.length - othersEnd) * pitch}px"></div>
    </div>
  {/if}

  {#if !loaded}
    <div class="p-3">
      <Skeleton count={6} height="h-14" />
    </div>
  {:else if total === 0}
    <EmptyState title={query.trim() ? $t('contacts.noMatching') : $t('contacts.empty')} />
  {/if}
</div>
