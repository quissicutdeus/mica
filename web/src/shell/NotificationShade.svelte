<script lang="ts">
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { isShadeOpen, closeShade } from './state/shade';
  import {
    shadeNotifications,
    totalUnreadNotifications,
    loadShadeNotifications,
    loadNotificationHistory,
    loadUnreadCounts,
    markNotificationsRead,
    clearNotifications,
    clearAllNotifications,
    restoreNotifications
  } from '../services/notifications';
  import { openApp } from './state/navigation';
  import type { NotificationItem } from '@shared/types';
  import Avatar from '../sdk/ui/Avatar.svelte';
  import CloseIcon from '../sdk/ui/icons/CloseIcon.svelte';
  import TrashIcon from '../sdk/ui/icons/TrashIcon.svelte';
  import CheckIcon from '../sdk/ui/icons/CheckIcon.svelte';
  import ChevronLeftIcon from '../sdk/ui/icons/ChevronLeftIcon.svelte';
  import ArchiveIcon from '../sdk/ui/icons/ArchiveIcon.svelte';
  import ChevronDownIcon from '../sdk/ui/icons/ChevronDownIcon.svelte';

  let notifications = $derived($shadeNotifications);
  let totalUnread = $derived($totalUnreadNotifications);

  interface NotificationGroup {
    app: string;
    items: NotificationItem[];
    latest: NotificationItem;
  }

  let groupedNotifications = $derived.by(() => {
    const groupsMap = new Map<string, NotificationItem[]>();
    for (const item of notifications) {
      const list = groupsMap.get(item.app) || [];
      list.push(item);
      groupsMap.set(item.app, list);
    }

    const groups: NotificationGroup[] = [];
    groupsMap.forEach((items, app) => {
      items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      groups.push({
        app,
        items,
        latest: items[0]
      });
    });

    groups.sort(
      (a, b) => new Date(b.latest.created_at).getTime() - new Date(a.latest.created_at).getTime()
    );

    return groups;
  });

  let expandedGroups = $state<Record<string, boolean>>({});

  const toggleGroupExpand = (app: string) => {
    expandedGroups[app] = !expandedGroups[app];
  };

  const handleClearGroup = async (e: MouseEvent, app: string) => {
    e.stopPropagation();
    await clearAllNotifications(app);
  };

  let showHistory = $state(false);
  let historyItems = $state<NotificationItem[]>([]);
  let loadingHistory = $state(false);

  let groupedHistory = $derived.by(() => {
    const groupsMap = new Map<string, NotificationItem[]>();
    for (const item of historyItems) {
      const list = groupsMap.get(item.app) || [];
      list.push(item);
      groupsMap.set(item.app, list);
    }

    const groups: NotificationGroup[] = [];
    groupsMap.forEach((items, app) => {
      items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      groups.push({
        app,
        items,
        latest: items[0]
      });
    });

    groups.sort(
      (a, b) => new Date(b.latest.created_at).getTime() - new Date(a.latest.created_at).getTime()
    );

    return groups;
  });

  let expandedHistoryGroups = $state<Record<string, boolean>>({});

  const toggleHistoryGroupExpand = (app: string) => {
    expandedHistoryGroups[app] = !expandedHistoryGroups[app];
  };

  const handleRestoreSingle = async (e: MouseEvent, id: number) => {
    e.stopPropagation();
    await restoreNotifications([id]);
    historyItems = historyItems.filter((i) => i.id !== id);
  };

  const handleRestoreGroup = async (e: MouseEvent, app: string) => {
    e.stopPropagation();
    const groupItemIds = historyItems.filter((i) => i.app === app).map((i) => i.id);
    await restoreNotifications(groupItemIds);
    historyItems = historyItems.filter((i) => i.app !== app);
  };

  onMount(() => {
    void loadShadeNotifications();
    void loadUnreadCounts();
  });

  const openHistory = async () => {
    loadingHistory = true;
    showHistory = true;
    try {
      historyItems = await loadNotificationHistory();
    } finally {
      loadingHistory = false;
    }
  };

  const closeHistory = () => {
    showHistory = false;
  };

  const formatTimestamp = (raw: Date | string) => {
    try {
      const date = new Date(raw);
      if (isNaN(date.getTime())) return '';
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}d ago`;
    } catch {
      return '';
    }
  };

  const handleRowClick = async (item: NotificationItem) => {
    if (!item.read_at) {
      await markNotificationsRead([item.id]);
    }
    if (item.deep_link) {
      openApp(item.deep_link);
      closeShade();
    }
  };

  const handleClearSingle = async (e: MouseEvent, id: number) => {
    e.stopPropagation();
    await clearNotifications([id]);
  };

  const handleClearAll = async () => {
    await clearAllNotifications();
  };
  let isDragging = $state(false);
  let startY = $state(0);
  let dragOffsetY = $state(0);

  const handlePointerDown = (e: PointerEvent) => {
    isDragging = true;
    startY = e.clientY;
    dragOffsetY = 0;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDragging) return;
    dragOffsetY = e.clientY - startY;
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!isDragging) return;
    isDragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    if (dragOffsetY < -100) {
      closeShade();
    }
    dragOffsetY = 0;
  };
</script>

{#if $isShadeOpen}
  <!-- Background Backdrop -->
  <div
    transition:fade={{ duration: 200 }}
    class="bg-scrim absolute inset-0 z-40 backdrop-blur-sm"
    onclick={closeShade}
    role="presentation"
  ></div>

  <!-- Notification Shade Drawer -->
  <div
    transition:fly={{ y: -850, duration: 300 }}
    class="bg-surface-overlay absolute inset-0 z-50 flex h-full w-full flex-col pt-10 pb-2 text-white shadow-2xl backdrop-blur-3xl"
    role="dialog"
    aria-label="Notification Shade"
  >
    <!-- Header Bar -->
    <div class="mb-4 flex items-center justify-between px-6">
      <div class="flex items-baseline gap-2">
        <h2 class="text-lg font-bold tracking-tight text-white">Notifications</h2>
        <span class="text-xs font-semibold tracking-wider text-blue-400 uppercase">
          {showHistory ? 'Archive' : 'Active'}
        </span>
      </div>

      <div class="flex items-center gap-1.5">
        {#if !showHistory}
          {#if notifications.length > 0}
            <button
              type="button"
              class="rounded-full bg-gray-900 p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-red-400"
              onclick={handleClearAll}
              title="Clear all notifications"
              aria-label="Clear all notifications"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          {/if}

          <button
            type="button"
            class="rounded-full bg-gray-900 p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-blue-400"
            onclick={openHistory}
            title="Notification Archive"
            aria-label="Notification Archive"
          >
            <ArchiveIcon class="h-4 w-4" />
          </button>
        {:else}
          <button
            type="button"
            class="rounded-full bg-gray-800 p-2 text-blue-400 ring-1 ring-blue-500 transition-colors hover:bg-gray-700 hover:text-blue-300"
            onclick={closeHistory}
            title="Back to Active Notifications"
            aria-label="Back to Active Notifications"
          >
            <ArchiveIcon class="h-4 w-4" />
          </button>
        {/if}

        <button
          type="button"
          class="rounded-full bg-gray-900 p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
          onclick={closeShade}
          title="Close"
          aria-label="Close notification shade"
        >
          <CloseIcon class="h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- Notification List Area -->
    <div class="flex-1 scrollbar-none overflow-y-auto px-5">
      {#if showHistory}
        <!-- History List View -->
        {#if loadingHistory}
          <div class="flex h-full flex-col items-center justify-center space-y-2 text-gray-500">
            <p class="text-sm">Loading archive...</p>
          </div>
        {:else if historyItems.length === 0}
          <div
            class="flex h-full flex-col items-center justify-center space-y-3 text-center text-gray-500"
          >
            <div
              class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-900 ring-1 ring-gray-800"
            >
              <ArchiveIcon class="h-7 w-7 text-gray-400" />
            </div>
            <div>
              <p class="text-sm font-semibold text-gray-300">No Archive Yet</p>
              <p class="text-xs text-gray-500">Cleared notifications will appear here</p>
            </div>
          </div>
        {:else}
          <div class="space-y-3 pb-4">
            {#each groupedHistory as group (group.app)}
              {#if group.items.length === 1}
                <!-- Standalone Single Archive Notification -->
                {@const item = group.latest}
                <div
                  transition:fly={{ y: 10, duration: 150 }}
                  class="group relative flex cursor-pointer items-start gap-3 rounded-2xl border border-gray-800 bg-gray-900 p-3.5 opacity-90 shadow-lg backdrop-blur-md transition-all hover:border-gray-700 hover:bg-gray-900 hover:opacity-100 active:scale-[0.99]"
                  onclick={() => handleRowClick(item)}
                  role="button"
                  tabindex={0}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void handleRowClick(item);
                    }
                  }}
                >
                  <!-- Avatar / App Icon -->
                  <div class="shrink-0 pt-0.5">
                    <Avatar
                      src={item.avatar ?? undefined}
                      initials={item.app ? item.app[0].toUpperCase() : 'N'}
                      size="w-9 h-9"
                      textClass="text-sm font-bold"
                    />
                  </div>

                  <!-- Content Area -->
                  <div class="min-w-0 flex-1 space-y-0.5">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-xs font-semibold tracking-wide text-blue-400 uppercase">
                        {item.app}
                      </span>
                      <div class="flex items-center gap-2">
                        <span class="text-[10px] font-medium text-gray-500">
                          {formatTimestamp(item.cleared_at ?? item.created_at)}
                        </span>
                        <button
                          type="button"
                          class="shrink-0 rounded-full p-1 text-red-400 transition-all hover:bg-gray-800 hover:text-white"
                          onclick={(e) => handleRestoreSingle(e, item.id)}
                          title="Restore to Active notifications"
                          aria-label="Restore to Active notifications"
                        >
                          <TrashIcon class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <h3 class="truncate text-sm font-semibold text-white">
                      {item.title}
                    </h3>

                    <p class="line-clamp-2 text-xs leading-relaxed text-gray-300">
                      {item.body}
                    </p>
                  </div>
                </div>
              {:else}
                <!-- Grouped Collapsible Archive Stack -->
                <div
                  class="rounded-2xl border border-gray-800 bg-gray-900 p-3.5 opacity-90 shadow-xl backdrop-blur-md hover:opacity-100"
                >
                  <!-- Group Header Card -->
                  <div
                    class="flex cursor-pointer items-start gap-3 select-none"
                    onclick={() => toggleHistoryGroupExpand(group.app)}
                    role="button"
                    tabindex={0}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleHistoryGroupExpand(group.app);
                      }
                    }}
                  >
                    <div class="shrink-0 pt-0.5">
                      <Avatar
                        src={group.latest.avatar ?? undefined}
                        initials={group.app ? group.app[0].toUpperCase() : 'N'}
                        size="w-9 h-9"
                        textClass="text-sm font-bold"
                      />
                    </div>

                    <div class="min-w-0 flex-1 space-y-0.5">
                      <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                          <span class="text-xs font-bold tracking-wide text-blue-400 uppercase">
                            {group.app}
                          </span>
                          <span
                            class="inline-flex items-center rounded-full bg-blue-900 px-2 py-0.5 text-[10px] font-semibold text-blue-300 ring-1 ring-blue-700"
                          >
                            {group.items.length} notifications
                          </span>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <span class="text-[10px] font-medium text-gray-500">
                            {formatTimestamp(group.latest.cleared_at ?? group.latest.created_at)}
                          </span>
                          <button
                            type="button"
                            class="rounded-full p-1 text-red-400 transition-colors hover:bg-gray-800 hover:text-white"
                            onclick={(e) => handleRestoreGroup(e, group.app)}
                            title={`Restore all ${group.app} notifications`}
                            aria-label={`Restore all ${group.app} notifications`}
                          >
                            <TrashIcon class="h-3.5 w-3.5" />
                          </button>
                          <ChevronDownIcon
                            class="h-4 w-4 text-gray-400 transition-transform duration-200 {expandedHistoryGroups[
                              group.app
                            ]
                              ? 'rotate-180 text-blue-400'
                              : ''}"
                          />
                        </div>
                      </div>

                      <h3 class="truncate text-sm font-semibold text-white">
                        {group.latest.title}
                      </h3>
                      <p class="line-clamp-1 text-xs text-gray-400">
                        {group.latest.body}
                      </p>
                    </div>
                  </div>

                  <!-- Expanded Group Sub-items List -->
                  {#if expandedHistoryGroups[group.app]}
                    <div
                      transition:fly={{ y: -5, duration: 150 }}
                      class="mt-3 space-y-2 border-t border-gray-800 pt-2.5 pr-1 pl-2"
                    >
                      {#each group.items as childItem (childItem.id)}
                        <div
                          class="group/item flex cursor-pointer items-start gap-2.5 rounded-xl border border-gray-800 bg-gray-950 p-2.5 transition-colors hover:border-gray-700 hover:bg-gray-800 active:scale-[0.99]"
                          onclick={() => handleRowClick(childItem)}
                          role="button"
                          tabindex={0}
                          onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void handleRowClick(childItem);
                            }
                          }}
                        >
                          <div class="min-w-0 flex-1 space-y-0.5">
                            <div class="flex items-center justify-between gap-2">
                              <h4 class="truncate text-xs font-semibold text-white">
                                {childItem.title}
                              </h4>
                              <div class="flex items-center gap-1.5">
                                <span class="text-[10px] text-gray-500">
                                  {formatTimestamp(childItem.cleared_at ?? childItem.created_at)}
                                </span>
                                <button
                                  type="button"
                                  class="rounded-full p-0.5 text-red-400 transition-colors hover:text-white"
                                  onclick={(e) => handleRestoreSingle(e, childItem.id)}
                                  title="Restore to Active notifications"
                                  aria-label="Restore to Active notifications"
                                >
                                  <TrashIcon class="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            <p class="line-clamp-2 text-xs leading-relaxed text-gray-300">
                              {childItem.body}
                            </p>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      {:else}
        <!-- Active Notifications View -->
        {#if notifications.length === 0}
          <!-- Clean Non-interactive Empty State -->
          <div
            class="flex h-full w-full flex-col items-center justify-center space-y-3.5 text-center select-none"
          >
            <div
              class="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-900 shadow-md ring-1 ring-gray-800"
            >
              <CheckIcon class="h-8 w-8 text-emerald-400" />
            </div>
            <div>
              <p class="text-base font-semibold text-gray-200">No New Notifications</p>
            </div>
          </div>
        {:else}
          <div class="space-y-3 pb-4">
            {#each groupedNotifications as group (group.app)}
              {#if group.items.length === 1}
                <!-- Standalone Single App Notification -->
                {@const item = group.latest}
                <div
                  transition:fly={{ y: 10, duration: 150 }}
                  class="group relative flex cursor-pointer items-start gap-3 rounded-2xl border border-gray-800 bg-gray-900 p-3.5 shadow-lg backdrop-blur-md transition-all hover:border-gray-700 hover:bg-gray-900 active:scale-[0.99]"
                  onclick={() => handleRowClick(item)}
                  role="button"
                  tabindex={0}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void handleRowClick(item);
                    }
                  }}
                >
                  <!-- Avatar / App Icon -->
                  <div class="shrink-0 pt-0.5">
                    <Avatar
                      src={item.avatar ?? undefined}
                      initials={item.app ? item.app[0].toUpperCase() : 'N'}
                      size="w-9 h-9"
                      textClass="text-sm font-bold"
                    />
                  </div>

                  <!-- Content Area -->
                  <div class="min-w-0 flex-1 space-y-0.5">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-xs font-semibold tracking-wide text-blue-400 uppercase">
                        {item.app}
                      </span>
                      <div class="flex items-center gap-2">
                        <span class="text-[10px] font-medium text-gray-500">
                          {formatTimestamp(item.created_at)}
                        </span>
                        <button
                          type="button"
                          class="shrink-0 rounded-full p-1 text-gray-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-gray-800 hover:text-red-400"
                          onclick={(e) => handleClearSingle(e, item.id)}
                          title="Clear notification"
                          aria-label="Clear notification"
                        >
                          <TrashIcon class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <h3 class="truncate text-sm font-semibold text-white">
                      {item.title}
                    </h3>

                    <p class="line-clamp-2 text-xs leading-relaxed text-gray-300">
                      {item.body}
                    </p>
                  </div>
                </div>
              {:else}
                <!-- Grouped Collapsible App Stack -->
                <div
                  class="rounded-2xl border border-gray-800 bg-gray-900 p-3.5 shadow-xl backdrop-blur-md"
                >
                  <!-- Group Header Card -->
                  <div
                    class="flex cursor-pointer items-start gap-3 select-none"
                    onclick={() => toggleGroupExpand(group.app)}
                    role="button"
                    tabindex={0}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroupExpand(group.app);
                      }
                    }}
                  >
                    <div class="shrink-0 pt-0.5">
                      <Avatar
                        src={group.latest.avatar ?? undefined}
                        initials={group.app ? group.app[0].toUpperCase() : 'N'}
                        size="w-9 h-9"
                        textClass="text-sm font-bold"
                      />
                    </div>

                    <div class="min-w-0 flex-1 space-y-0.5">
                      <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                          <span class="text-xs font-bold tracking-wide text-blue-400 uppercase">
                            {group.app}
                          </span>
                          <span
                            class="inline-flex items-center rounded-full bg-blue-900 px-2 py-0.5 text-[10px] font-semibold text-blue-300 ring-1 ring-blue-700"
                          >
                            {group.items.length} notifications
                          </span>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <span class="text-[10px] font-medium text-gray-500">
                            {formatTimestamp(group.latest.created_at)}
                          </span>
                          <button
                            type="button"
                            class="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-red-400"
                            onclick={(e) => handleClearGroup(e, group.app)}
                            title={`Clear all ${group.app} notifications`}
                            aria-label={`Clear all ${group.app} notifications`}
                          >
                            <TrashIcon class="h-3.5 w-3.5" />
                          </button>
                          <ChevronDownIcon
                            class="h-4 w-4 text-gray-400 transition-transform duration-200 {expandedGroups[
                              group.app
                            ]
                              ? 'rotate-180 text-blue-400'
                              : ''}"
                          />
                        </div>
                      </div>

                      <h3 class="truncate text-sm font-semibold text-white">
                        {group.latest.title}
                      </h3>
                      <p class="line-clamp-1 text-xs text-gray-400">
                        {group.latest.body}
                      </p>
                    </div>
                  </div>

                  <!-- Expanded Group Sub-items List -->
                  {#if expandedGroups[group.app]}
                    <div
                      transition:fly={{ y: -5, duration: 150 }}
                      class="mt-3 space-y-2 border-t border-gray-800 pt-2.5 pr-1 pl-2"
                    >
                      {#each group.items as childItem (childItem.id)}
                        <div
                          class="group/item flex cursor-pointer items-start gap-2.5 rounded-xl border border-gray-800 bg-gray-950 p-2.5 transition-colors hover:border-gray-700 hover:bg-gray-800 active:scale-[0.99]"
                          onclick={() => handleRowClick(childItem)}
                          role="button"
                          tabindex={0}
                          onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void handleRowClick(childItem);
                            }
                          }}
                        >
                          <div class="min-w-0 flex-1 space-y-0.5">
                            <div class="flex items-center justify-between gap-2">
                              <h4 class="truncate text-xs font-semibold text-white">
                                {childItem.title}
                              </h4>
                              <div class="flex items-center gap-1.5">
                                <span class="text-[10px] text-gray-500">
                                  {formatTimestamp(childItem.created_at)}
                                </span>
                                <button
                                  type="button"
                                  class="rounded-full p-0.5 text-gray-500 opacity-0 transition-opacity group-hover/item:opacity-100 hover:text-red-400"
                                  onclick={(e) => handleClearSingle(e, childItem.id)}
                                  title="Clear notification"
                                  aria-label="Clear notification"
                                >
                                  <TrashIcon class="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            <p class="line-clamp-2 text-xs leading-relaxed text-gray-300">
                              {childItem.body}
                            </p>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
