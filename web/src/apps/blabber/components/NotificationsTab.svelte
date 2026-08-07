<script lang="ts">
  import {
    useNotifications,
    EmptyState,
    Skeleton,
    Avatar,
    BellIcon,
    UsersIcon,
    MessageIcon
  } from '@gphone/sdk';
  import type { NotificationItem } from '@shared/types';
  import { parseDeepLink } from '@shared/deepLink';

  interface Props {
    onopenblab?: (blabId: number) => void;
    onopenhandle?: (handle: string) => void;
  }

  let { onopenblab, onopenhandle }: Props = $props();

  const { notificationsStore, load, markRead } = useNotifications('blabber');

  let notifications = $derived($notificationsStore);
  let loading = $state(true);

  $effect(() => {
    void load().then(() => {
      loading = false;
    });
  });

  const handleItemClick = (item: NotificationItem) => {
    if (!item.read_at) {
      void markRead([item.id]);
    }

    // The shared parser, not a private regex. This file used to own the only working
    // deep-link reader in the phone, which is why a mention opened from here and from
    // nowhere else — the shade handed the raw string to `openApp` and blanked the screen.
    const link = item.deep_link ? parseDeepLink(item.deep_link) : null;
    if (!link) return;

    if (typeof link.props.blabId === 'number' && onopenblab) {
      onopenblab(link.props.blabId);
    } else if (typeof link.props.handle === 'string' && onopenhandle) {
      onopenhandle(link.props.handle);
    }
  };

  const getNotificationKind = (item: NotificationItem): 'mention' | 'follow' | 'dm' | 'general' => {
    if (item.kind === 'follow' || item.title.includes('followed you')) return 'follow';
    if (item.kind === 'dm' || item.app === 'messages') return 'dm';
    if (item.kind === 'mention' || item.title.includes('mentioned')) return 'mention';
    return 'general';
  };
</script>

<div class="flex-1 overflow-y-auto pb-20">
  {#if loading}
    <div class="p-4"><Skeleton count={4} height="h-16" /></div>
  {:else if notifications.length === 0}
    <EmptyState
      title="No Activity Yet"
      description="When people mention you, follow your profile, or reply to your Blabs, you will see it here."
    />
  {:else}
    <div class="divide-outline-variant divide-y">
      {#each notifications as item (item.id)}
        {@const kind = getNotificationKind(item)}
        <button
          type="button"
          class="hover:bg-surface-container flex w-full cursor-pointer items-start gap-3.5 px-4 py-3.5 text-left transition-colors {!item.read_at
            ? 'bg-surface'
            : ''}"
          onclick={() => handleItemClick(item)}
        >
          <!-- Left Avatar / Activity Badge -->
          <div class="relative shrink-0 pt-0.5">
            {#if item.avatar}
              <Avatar src={item.avatar} size="md" />
            {:else}
              <div
                class="text-on-surface flex h-10 w-10 items-center justify-center rounded-full font-bold shadow-sm {kind ===
                'follow'
                  ? 'bg-secondary'
                  : kind === 'mention'
                    ? 'bg-primary'
                    : 'bg-surface-container-high'}"
              >
                {#if kind === 'follow'}
                  <UsersIcon class="text-on-surface h-5 w-5" />
                {:else if kind === 'mention'}
                  <span class="text-sm">@</span>
                {:else if kind === 'dm'}
                  <MessageIcon class="text-on-surface h-5 w-5" />
                {:else}
                  <BellIcon class="text-on-surface h-5 w-5" />
                {/if}
              </div>
            {/if}

            <!-- Kind Badge Overlay -->
            <div
              class="border-surface text-on-surface absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full border-2 text-[10px] font-bold {kind ===
              'follow'
                ? 'bg-secondary'
                : kind === 'mention'
                  ? 'bg-primary'
                  : 'bg-surface-container-highest'}"
            >
              {#if kind === 'follow'}
                +
              {:else if kind === 'mention'}
                @
              {:else}
                •
              {/if}
            </div>
          </div>

          <!-- Main Notification Body -->
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-on-surface truncate text-sm font-semibold">{item.title}</span>
              <span class="text-on-surface-variant shrink-0 text-[11px] font-medium">
                {new Date(item.created_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </div>

            <p class="text-on-surface mt-1 line-clamp-2 text-xs leading-relaxed">
              {item.body}
            </p>
          </div>

          {#if !item.read_at}
            <span class="bg-primary mt-2 h-2 w-2 shrink-0 rounded-full"></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
