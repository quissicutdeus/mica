<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import ScreenHeader from './ScreenHeader.svelte';

  let {
    title,
    onback,
    ontitleclick,
    actions,
    overlay,
    children,
    class: className = ''
  } = $props<{
    title: string;
    onback?: () => void;
    ontitleclick?: () => void;
    actions?: Snippet;
    overlay?: Snippet;
    children: Snippet;
    class?: string;
  }>();
</script>

<div class="bg-surface text-on-surface relative flex h-full flex-col {className}">
  <!-- Header -->
  <ScreenHeader {title} {onback} {ontitleclick} {actions} />

  <!-- Content.

       Two boxes, and the inner one is the app's whole world.

       The outer box is the scroller and owns the *height*: `min-h-0` is what lets a flex
       item actually shrink to its share instead of its content, so this is exactly the gap
       between the header and the bottom of the phone, no matter what is rendered inside.

       The inner box hands that height on. It is `h-full` — a definite height, resolved
       against a scroller that has one — and that is the whole of the contract. A child
       that asks to fill gets the screen and nothing more; a child that is genuinely taller
       overflows it and the scroller scrolls, which is what a feed wants.

       It used to be `min-h-full`: a floor and no ceiling, so its own height stayed `auto`.
       That made percentage heights inside it meaningless (`h-full` on a child resolved to
       `auto` — its own content's height, MICA-89) and, worse, made `flex-1` fill without
       *bounding*, because a flex item in an auto-height column is sized by its content once
       the content is the larger of the two. Views with fixed chrome came apart under enough
       content: Blabber's DM composer walked ~82px down the screen per message sent, and the
       core Messages thread put its composer 4000px below the visible screen.

       So the contract for apps is: fill with `min-h-0 flex-1`, never with a percentage
       height. `flex-1` claims the leftover space; `min-h-0` is the half that is easy to
       forget and the half that does the work, because a flex item's default `min-height:
       auto` resolves to its own content's minimum and will refuse to shrink to its share
       without it. A child that declares `overflow-y-auto` is already exempt from that
       default and scrolls itself; anything else needs the class.

       `web/src/lib/utilityClasses.test.ts` enforces both halves statically. -->
  <div class="no-scrollbar relative min-h-0 flex-1 overflow-y-auto">
    <div class="flex h-full flex-col">
      {@render children()}
    </div>
  </div>

  {#if overlay}
    {@render overlay()}
  {/if}
</div>
