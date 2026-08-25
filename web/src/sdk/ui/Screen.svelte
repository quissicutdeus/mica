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

       The inner box is what makes that a boundary an app cannot argue with. It has a
       floor and no ceiling — `min-h-full`, never `h-full` — so it is always at least a
       full screen (a short app fills its background rather than floating in dead space)
       and grows past one when there is genuinely more to show (a feed still scrolls).
       Crucially its *height* stays `auto`, and a percentage height needs a definite parent
       to resolve against. An app that writes `h-full` therefore gets `auto` — its own
       content's height — instead of conjuring a second full screen the way it used to.
       That was the bug: `h-full` inside a non-flex scroller meant tabs *plus* a whole
       screen, and the app scrolled when it had nothing to scroll.

       So the contract for apps is: fill with `flex-1`, not with a percentage height.
       Percentage heights simply have nothing to bite on here, which is the point — the
       shell decides how tall an app is, and the app decides how to divide that up. -->
  <div class="no-scrollbar relative min-h-0 flex-1 overflow-y-auto">
    <div class="flex min-h-full flex-col">
      {@render children()}
    </div>
  </div>

  {#if overlay}
    {@render overlay()}
  {/if}
</div>
