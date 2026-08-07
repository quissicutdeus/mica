<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { audio } from '../../shell/state/audio';
  import { wallpaperNeedsContrast } from '../../shell/state/wallpaper';

  let {
    name,
    icon: Icon,
    color,
    badge = 0,
    badgeStore,
    onclick
  }: {
    name: string;
    icon: Component<any> | Snippet | string | null;
    color: string;
    badge?: number;
    badgeStore?: Readable<number>;
    onclick: () => void;
  } = $props();

  let storeBadge = $state(0);

  $effect(() => {
    if (badgeStore && typeof badgeStore.subscribe === 'function') {
      const unsubscribe = badgeStore.subscribe((val: number) => {
        storeBadge = val || 0;
      });
      return () => unsubscribe();
    }
  });

  let displayBadge = $derived(badgeStore ? storeBadge : badge);

  const handleClick = () => {
    audio.play('click');
    onclick();
  };
</script>

<button
  class="group relative flex cursor-pointer flex-col items-center gap-2"
  onclick={handleClick}
>
  <div
    class="h-14 w-14 rounded-2xl {color} relative flex cursor-pointer items-center justify-center shadow-lg transition-transform group-hover:scale-105 group-active:scale-95"
  >
    {#if typeof Icon === 'string'}
      <img src={Icon} alt={name} class="pointer-events-none h-8 w-8 object-contain" />
    {:else if Icon}
      <Icon />
    {/if}

    {#if displayBadge > 0}
      <!-- Unread badge.

           No separator ring. It carried `border-2 border-surface` — a near-black 2px
           ring, `border-gray-900` before the M3 migration — which reads as an artifact
           now that a wallpaper can be a bright photo: the badge overhangs the tile by
           design, so most of that ring sat on the photograph rather than on the icon.

           What the ring bought was separation from a same-colored tile, and Admin is the
           case that shows it: a red badge on a red tile. `shadow-md` is what carries that
           now. If it turns out not to be enough, the answer is a ring in a color that
           belongs to the badge rather than to the surface behind it.
           -->
      <div
        class="bg-error text-on-error absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[10px] font-bold shadow-md"
      >
        {displayBadge > 99 ? '99+' : displayBadge}
      </div>
    {/if}
  </div>
  <!-- The outline is on this label and nothing else in the icon. It was briefly on the
       launcher container instead, which was wrong twice over: `-webkit-text-stroke`
       inherits, so a 3px stroke closed up the 10px unread count until it was unreadable,
       and `paint-order` reaches SVG too. Only this text sits directly on the wallpaper.

       `px-1` is load-bearing, not spacing. `truncate` sets `overflow: hidden`, and the
       stroke paints ~1.5px outside the glyph, so without padding the first and last
       letters are shaved flat against the box edge. `max-w` grew by the same 8px so the
       text still gets its old width before truncating. -->
  <span
    class="text-on-surface max-w-[72px] truncate px-1 text-xs font-medium"
    class:text-on-wallpaper={$wallpaperNeedsContrast}>{name}</span
  >
</button>
