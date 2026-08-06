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

  interface Props {
    onopenblab?: (blabId: number) => void;
    onopenhandle?: (handle: string) => void;
  }

  let { onopenblab, onopenhandle }: Props = $props();

  const { notificationsStore, unreadCount, load, markRead } = useNotifications('blabber');

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

    if (item.deep_link) {
      const match = item.deep_link.match(/blab\/(\d+)/);
      if (match && onopenblab) {
        onopenblab(parseInt(match[1], 10));
        return;
      }
      const handleMatch = item.deep_link.match(/profile\/([a-zA-Z0-9_]+)/);
      if (handleMatch && onopenhandle) {
        onopenhandle(handleMatch[1]);
        return;
      }
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
    <div class="divide-y divide-gray-800">
      {#each notifications as item (item.id)}
        {@const kind = getNotificationKind(item)}
        <button
          type="button"
          class="flex w-full cursor-pointer items-start gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-gray-800 {!item.read_at
            ? 'bg-gray-900'
            : ''}"
          onclick={() => handleItemClick(item)}
        >
          <!-- Left Avatar / Activity Badge -->
          <div class="relative shrink-0 pt-0.5">
            {#if item.avatar}
              <Avatar src={item.avatar} size="md" />
            {:else}
              <div
                class="flex h-10 w-10 items-center justify-center rounded-full font-bold text-white shadow-sm {kind ===
                'follow'
                  ? 'bg-indigo-600'
                  : kind === 'mention'
                    ? 'bg-blue-600'
                    : 'bg-gray-700'}"
              >
                {#if kind === 'follow'}
                  <UsersIcon class="h-5 w-5 text-white" />
                {:else if kind === 'mention'}
                  <span class="text-sm">@</span>
                {:else if kind === 'dm'}
                  <MessageIcon class="h-5 w-5 text-white" />
                {:else}
                  <BellIcon class="h-5 w-5 text-white" />
                {/if}
              </div>
            {/if}

            <!-- Kind Badge Overlay -->
            <div
              class="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-gray-900 text-[10px] font-bold text-white {kind ===
              'follow'
                ? 'bg-indigo-500'
                : kind === 'mention'
                  ? 'bg-blue-500'
                  : 'bg-gray-600'}"
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
              <span class="truncate text-sm font-semibold text-white">{item.title}</span>
              <span class="shrink-0 text-[11px] font-medium text-gray-400">
                {new Date(item.created_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </div>

            <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-300">
              {item.body}
            </p>
          </div>

          {#if !item.read_at}
            <span class="mt-2 h-2 w-2 shrink-0 rounded-full bg-blue-500"></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
