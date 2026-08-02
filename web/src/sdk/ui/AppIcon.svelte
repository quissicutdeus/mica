<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { audio } from '../../shell/state/audio';

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
      <!-- Red Unread Notification Badge -->
      <div
        class="absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 border-gray-900 bg-rose-500 px-1 text-[10px] font-bold text-white shadow-md"
      >
        {displayBadge > 99 ? '99+' : displayBadge}
      </div>
    {/if}
  </div>
  <span class="max-w-[64px] truncate text-xs font-medium text-gray-300">{name}</span>
</button>
