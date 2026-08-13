<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fly, fade } from 'svelte/transition';
  import { isShadeOpen, closeShade, shadeDragProgress, shadeDragPhase } from './state/shade';
  import { attachDragGesture, clampProgress, shouldCommitDrag } from '../lib/pointerDrag';
  import { SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import {
    shadeNotifications,
    loadShadeNotifications,
    loadNotificationHistory,
    loadUnreadCounts,
    markNotificationsRead,
    clearNotifications,
    clearAllNotifications,
    restoreNotifications
  } from '../services/notifications';
  import { openApp } from './state/navigation';
  import { parseDeepLink } from '@shared/deepLink';
  import type { NotificationItem } from '@shared/types';
  import Avatar from '../sdk/ui/Avatar.svelte';
  import CloseIcon from '../sdk/ui/icons/CloseIcon.svelte';
  import TrashIcon from '../sdk/ui/icons/TrashIcon.svelte';
  import CheckIcon from '../sdk/ui/icons/CheckIcon.svelte';
  import ArchiveIcon from '../sdk/ui/icons/ArchiveIcon.svelte';
  import ChevronDownIcon from '../sdk/ui/icons/ChevronDownIcon.svelte';
  import SwipeableRow from './SwipeableRow.svelte';

  let notifications = $derived($shadeNotifications);

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

  const clearGroup = async (app: string) => {
    await clearAllNotifications(app);
  };

  const handleClearGroup = async (e: MouseEvent, app: string) => {
    e.stopPropagation();
    await clearGroup(app);
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

  const restoreSingle = async (id: number) => {
    await restoreNotifications([id]);
    historyItems = historyItems.filter((i) => i.id !== id);
  };

  const handleRestoreSingle = async (e: MouseEvent, id: number) => {
    e.stopPropagation();
    await restoreSingle(id);
  };

  const restoreGroup = async (app: string) => {
    const groupItemIds = historyItems.filter((i) => i.app === app).map((i) => i.id);
    await restoreNotifications(groupItemIds);
    historyItems = historyItems.filter((i) => i.app !== app);
  };

  const handleRestoreGroup = async (e: MouseEvent, app: string) => {
    e.stopPropagation();
    await restoreGroup(app);
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
    // Parsed, never passed whole. `openApp` takes an app id, and handing it `mail/12`
    // registered a resident app by that name — no component resolves it, so the phone
    // went blank with no way back.
    const link = item.deep_link ? parseDeepLink(item.deep_link) : null;
    if (link) {
      openApp(link.app, link.props);
      closeShade();
    }
  };

  const clearSingle = async (id: number) => {
    await clearNotifications([id]);
  };

  const handleClearSingle = async (e: MouseEvent, id: number) => {
    e.stopPropagation();
    await clearSingle(id);
  };

  const handleClearAll = async () => {
    await clearAllNotifications();
  };

  let handleRef = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!handleRef) return;
    return attachDragGesture(handleRef, {
      axis: 'y',
      onMove: (deltaY) => {
        shadeDragPhase.set('dragging');
        // Dragging up closes: deltaY goes negative as the finger pulls up, so progress
        // (1 = open) counts back down toward 0 (closed) as the pull continues.
        shadeDragProgress.set(clampProgress(1 + deltaY / SHADE_DRAG_REVEAL_DISTANCE));
      },
      onEnd: (_deltaY, velocity) => {
        shadeDragPhase.set('settling');
        // Reuse the open-drag commit heuristic, mirrored: "closing progress" is how far
        // back toward 0 the pull got, and a fast upward flick reads as positive closing
        // velocity even though the raw axis delta is negative while dragging up.
        const closingProgress = 1 - get(shadeDragProgress);
        const closingVelocity = -velocity;
        if (shouldCommitDrag(closingProgress, closingVelocity)) {
          shadeDragProgress.set(0);
          closeShade();
        } else {
          shadeDragProgress.set(1);
        }
      }
    });
  });

  /**
   * `ontransitionend` (below) is what normally flips `'settling'` back to `'idle'` once
   * the drawer's transform finishes easing to its target — which is also what lets the
   * `{#if}` guard unmount the drawer after a drag-driven close. But a `transitionend`
   * only fires when the animated property's value actually *changes*, and an overshoot
   * drag — dragged well past the reveal distance before release — already has
   * `shadeDragProgress` sitting at the commit target (0 or 1) by the time `'settling'`
   * begins, since the live drag itself already got there. Setting the same value again
   * produces no visual transition and therefore no event, so without this the shade got
   * stuck open (or stuck mounted) forever after a fast, full-distance drag. This timer is
   * the fallback: it force-settles to `'idle'` slightly after the CSS duration would have
   * finished, and is cancelled by the cleanup below whenever the real `transitionend`
   * fires first (phase changes away from `'settling'`, so this effect reruns).
   */
  $effect(() => {
    if ($shadeDragPhase !== 'settling') return;
    const timeout = setTimeout(() => {
      if (get(shadeDragPhase) === 'settling') shadeDragPhase.set('idle');
    }, 250);
    return () => clearTimeout(timeout);
  });
</script>

<!-- Drag-to-open (from the status bar, in `PhoneFrame.svelte`) and drag-to-close (from
     the grab handle below) both existed once as dead code — three pointer handlers never
     wired to any element, removed because wiring them as written would have broken
     scrolling: the drawer is `inset-0` around a scrolling list, and `setPointerCapture`
     on the drawer's own `pointerdown` would have taken every touch that starts on a
     notification row. What was missing was a grab handle to attach to, scoped away from
     the scrollable list, and a transform that follows the finger — both now exist below.
     Row swipe-to-clear/restore is `SwipeableRow.svelte`, same underlying gesture utility. -->

{#if $isShadeOpen || $shadeDragPhase !== 'idle'}
  {@const effectiveProgress =
    $shadeDragPhase === 'idle' ? ($isShadeOpen ? 1 : 0) : $shadeDragProgress}
  <!-- Background Backdrop -->
  <div
    transition:fade={{ duration: 200 }}
    class="bg-scrim absolute inset-0 z-40 backdrop-blur-sm"
    onclick={closeShade}
    role="presentation"
  ></div>

  <!-- Notification Shade Drawer.

       The inline `transform` tracks `effectiveProgress` continuously — raw during a live
       drag, eased only while `'settling'` (the post-release snap, whichever direction).
       `transition:fly` still drives the ordinary tap-triggered open/close exactly as
       before; its `duration` collapses to 0 whenever a drag is involved (checked at the
       instant the transition starts) so the two animation systems never fight over
       `transform` on the same frame — a drag-triggered mount would otherwise race the
       fly-in against the finger's live position. A drag-triggered *un*mount reusing the
       normal 300ms is harmless: by then the manual animation has already finished moving
       the drawer fully off-screen, so an extra invisible flight on top of that is
       unobservable. -->
  <div
    transition:fly={{ y: -850, duration: $shadeDragPhase === 'idle' ? 300 : 0 }}
    class="bg-surface-container-high text-on-surface absolute inset-0 z-50 flex h-full w-full flex-col pt-14 pb-2 shadow-2xl backdrop-blur-3xl {$shadeDragPhase ===
    'settling'
      ? 'transition-transform duration-200 ease-out'
      : ''}"
    style="transform: translateY({(1 - effectiveProgress) * -850}px)"
    ontransitionend={(e) => {
      if (
        e.target === e.currentTarget &&
        e.propertyName === 'transform' &&
        $shadeDragPhase === 'settling'
      ) {
        shadeDragPhase.set('idle');
      }
    }}
    role="dialog"
    aria-label="Notification Shade"
  >
    <!-- Grab Handle.

         Pointer-only, scoped by `data-gesture-drag` so `dragScroll.ts` never claims a
         press here, and deliberately not the drawer root or any part of the scrollable
         list below — that scoping is the whole fix for the conflict the removed code
         couldn't resolve. `aria-hidden` because it adds no action a keyboard/screen-reader
         user lacks: the Close button below is the existing accessible equivalent. -->
    <div
      bind:this={handleRef}
      class="flex w-full touch-none items-center justify-center py-2"
      data-gesture-drag
      data-testid="shade-grab-handle"
      role="presentation"
      aria-hidden="true"
    >
      <div class="bg-outline-variant h-1.5 w-10 rounded-full"></div>
    </div>

    <!-- Header Bar -->
    <div class="mb-4 flex items-center justify-between px-6">
      <div class="flex items-baseline gap-2">
        <h2 class="text-on-surface text-lg font-bold tracking-tight">Notifications</h2>
        <span class="text-primary text-xs font-semibold tracking-wider uppercase">
          {showHistory ? 'Archive' : 'Active'}
        </span>
      </div>

      <div class="flex items-center gap-1.5">
        {#if !showHistory}
          {#if notifications.length > 0}
            <button
              type="button"
              class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-error rounded-full p-2 transition-colors"
              onclick={handleClearAll}
              title="Clear all notifications"
              aria-label="Clear all notifications"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          {/if}

          <button
            type="button"
            class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-primary rounded-full p-2 transition-colors"
            onclick={openHistory}
            title="Notification Archive"
            aria-label="Notification Archive"
          >
            <ArchiveIcon class="h-4 w-4" />
          </button>
        {:else}
          <button
            type="button"
            class="bg-surface-container text-primary ring-primary hover:bg-surface-container-high hover:text-primary rounded-full p-2 ring-1 transition-colors"
            onclick={closeHistory}
            title="Back to Active Notifications"
            aria-label="Back to Active Notifications"
          >
            <ArchiveIcon class="h-4 w-4" />
          </button>
        {/if}

        <button
          type="button"
          class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-on-surface rounded-full p-2 transition-colors"
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
          <div
            class="text-on-surface-variant flex h-full flex-col items-center justify-center space-y-2"
          >
            <p class="text-sm">Loading archive...</p>
          </div>
        {:else if historyItems.length === 0}
          <div
            class="text-on-surface-variant flex h-full flex-col items-center justify-center space-y-3 text-center"
          >
            <div
              class="bg-surface ring-outline-variant flex h-14 w-14 items-center justify-center rounded-2xl ring-1"
            >
              <ArchiveIcon class="text-on-surface-variant h-7 w-7" />
            </div>
            <div>
              <p class="text-on-surface text-sm font-semibold">No Archive Yet</p>
              <p class="text-on-surface-variant text-xs">Cleared notifications will appear here</p>
            </div>
          </div>
        {:else}
          <div class="space-y-3 pb-4">
            {#each groupedHistory as group (group.app)}
              {#if group.items.length === 1}
                <!-- Standalone Single Archive Notification -->
                {@const item = group.latest}
                <SwipeableRow onCommit={() => restoreSingle(item.id)}>
                  <div
                    transition:fly={{ y: 10, duration: 150 }}
                    class="group border-outline-variant bg-surface hover:border-outline-variant hover:bg-surface relative flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 opacity-90 shadow-lg backdrop-blur-md transition-all hover:opacity-100 active:scale-[0.99]"
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
                        <span class="text-primary text-xs font-semibold tracking-wide uppercase">
                          {item.app}
                        </span>
                        <div class="flex items-center gap-2">
                          <span class="text-on-surface-variant text-[10px] font-medium">
                            {formatTimestamp(item.cleared_at ?? item.created_at)}
                          </span>
                          <button
                            type="button"
                            class="text-error hover:bg-surface-container hover:text-on-surface shrink-0 rounded-full p-1 transition-all"
                            onclick={(e) => handleRestoreSingle(e, item.id)}
                            title="Restore to Active notifications"
                            aria-label="Restore to Active notifications"
                          >
                            <TrashIcon class="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <h3 class="text-on-surface truncate text-sm font-semibold">
                        {item.title}
                      </h3>

                      <p class="text-on-surface line-clamp-2 text-xs leading-relaxed">
                        {item.body}
                      </p>
                    </div>
                  </div>
                </SwipeableRow>
              {:else}
                <!-- Grouped Collapsible Archive Stack -->
                <div
                  class="border-outline-variant bg-surface rounded-2xl border p-3.5 opacity-90 shadow-xl backdrop-blur-md hover:opacity-100"
                >
                  <!-- Group Header Card -->
                  <SwipeableRow onCommit={() => restoreGroup(group.app)}>
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
                            <span class="text-primary text-xs font-bold tracking-wide uppercase">
                              {group.app}
                            </span>
                            <span
                              class="bg-primary-container text-on-primary-container ring-primary inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1"
                            >
                              {group.items.length} notifications
                            </span>
                          </div>
                          <div class="flex items-center gap-1.5">
                            <span class="text-on-surface-variant text-[10px] font-medium">
                              {formatTimestamp(group.latest.cleared_at ?? group.latest.created_at)}
                            </span>
                            <button
                              type="button"
                              class="text-error hover:bg-surface-container hover:text-on-surface rounded-full p-1 transition-colors"
                              onclick={(e) => handleRestoreGroup(e, group.app)}
                              title={`Restore all ${group.app} notifications`}
                              aria-label={`Restore all ${group.app} notifications`}
                            >
                              <TrashIcon class="h-3.5 w-3.5" />
                            </button>
                            <ChevronDownIcon
                              class="text-on-surface-variant h-4 w-4 transition-transform duration-200 {expandedHistoryGroups[
                                group.app
                              ]
                                ? 'text-primary rotate-180'
                                : ''}"
                            />
                          </div>
                        </div>

                        <h3 class="text-on-surface truncate text-sm font-semibold">
                          {group.latest.title}
                        </h3>
                        <p class="text-on-surface-variant line-clamp-1 text-xs">
                          {group.latest.body}
                        </p>
                      </div>
                    </div>
                  </SwipeableRow>

                  <!-- Expanded Group Sub-items List -->
                  {#if expandedHistoryGroups[group.app]}
                    <div
                      transition:fly={{ y: -5, duration: 150 }}
                      class="border-outline-variant mt-3 space-y-2 border-t pt-2.5 pr-1 pl-2"
                    >
                      {#each group.items as childItem (childItem.id)}
                        <SwipeableRow onCommit={() => restoreSingle(childItem.id)}>
                          <div
                            class="group/item border-outline-variant bg-surface-container-lowest hover:border-outline-variant hover:bg-surface-container flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors active:scale-[0.99]"
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
                                <h4 class="text-on-surface truncate text-xs font-semibold">
                                  {childItem.title}
                                </h4>
                                <div class="flex items-center gap-1.5">
                                  <span class="text-on-surface-variant text-[10px]">
                                    {formatTimestamp(childItem.cleared_at ?? childItem.created_at)}
                                  </span>
                                  <button
                                    type="button"
                                    class="text-error hover:text-on-surface rounded-full p-0.5 transition-colors"
                                    onclick={(e) => handleRestoreSingle(e, childItem.id)}
                                    title="Restore to Active notifications"
                                    aria-label="Restore to Active notifications"
                                  >
                                    <TrashIcon class="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                              <p class="text-on-surface line-clamp-2 text-xs leading-relaxed">
                                {childItem.body}
                              </p>
                            </div>
                          </div>
                        </SwipeableRow>
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
              class="bg-surface ring-outline-variant flex h-16 w-16 items-center justify-center rounded-2xl shadow-md ring-1"
            >
              <CheckIcon class="h-8 w-8 text-emerald-400" />
            </div>
            <div>
              <p class="text-on-surface text-base font-semibold">No New Notifications</p>
            </div>
          </div>
        {:else}
          <div class="space-y-3 pb-4">
            {#each groupedNotifications as group (group.app)}
              {#if group.items.length === 1}
                <!-- Standalone Single App Notification -->
                {@const item = group.latest}
                <SwipeableRow onCommit={() => clearSingle(item.id)}>
                  <div
                    transition:fly={{ y: 10, duration: 150 }}
                    class="group border-outline-variant bg-surface hover:border-outline-variant hover:bg-surface relative flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 shadow-lg backdrop-blur-md transition-all active:scale-[0.99]"
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
                        <span class="text-primary text-xs font-semibold tracking-wide uppercase">
                          {item.app}
                        </span>
                        <div class="flex items-center gap-2">
                          <span class="text-on-surface-variant text-[10px] font-medium">
                            {formatTimestamp(item.created_at)}
                          </span>
                          <button
                            type="button"
                            class="text-on-surface-variant hover:bg-surface-container hover:text-error shrink-0 rounded-full p-1 opacity-0 transition-all group-hover:opacity-100"
                            onclick={(e) => handleClearSingle(e, item.id)}
                            title="Clear notification"
                            aria-label="Clear notification"
                          >
                            <TrashIcon class="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <h3 class="text-on-surface truncate text-sm font-semibold">
                        {item.title}
                      </h3>

                      <p class="text-on-surface line-clamp-2 text-xs leading-relaxed">
                        {item.body}
                      </p>
                    </div>
                  </div>
                </SwipeableRow>
              {:else}
                <!-- Grouped Collapsible App Stack -->
                <div
                  class="border-outline-variant bg-surface rounded-2xl border p-3.5 shadow-xl backdrop-blur-md"
                >
                  <!-- Group Header Card -->
                  <SwipeableRow onCommit={() => clearGroup(group.app)}>
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
                            <span class="text-primary text-xs font-bold tracking-wide uppercase">
                              {group.app}
                            </span>
                            <span
                              class="bg-primary-container text-on-primary-container ring-primary inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1"
                            >
                              {group.items.length} notifications
                            </span>
                          </div>
                          <div class="flex items-center gap-1.5">
                            <span class="text-on-surface-variant text-[10px] font-medium">
                              {formatTimestamp(group.latest.created_at)}
                            </span>
                            <button
                              type="button"
                              class="text-on-surface-variant hover:bg-surface-container hover:text-error rounded-full p-1 transition-colors"
                              onclick={(e) => handleClearGroup(e, group.app)}
                              title={`Clear all ${group.app} notifications`}
                              aria-label={`Clear all ${group.app} notifications`}
                            >
                              <TrashIcon class="h-3.5 w-3.5" />
                            </button>
                            <ChevronDownIcon
                              class="text-on-surface-variant h-4 w-4 transition-transform duration-200 {expandedGroups[
                                group.app
                              ]
                                ? 'text-primary rotate-180'
                                : ''}"
                            />
                          </div>
                        </div>

                        <h3 class="text-on-surface truncate text-sm font-semibold">
                          {group.latest.title}
                        </h3>
                        <p class="text-on-surface-variant line-clamp-1 text-xs">
                          {group.latest.body}
                        </p>
                      </div>
                    </div>
                  </SwipeableRow>

                  <!-- Expanded Group Sub-items List -->
                  {#if expandedGroups[group.app]}
                    <div
                      transition:fly={{ y: -5, duration: 150 }}
                      class="border-outline-variant mt-3 space-y-2 border-t pt-2.5 pr-1 pl-2"
                    >
                      {#each group.items as childItem (childItem.id)}
                        <SwipeableRow onCommit={() => clearSingle(childItem.id)}>
                          <div
                            class="group/item border-outline-variant bg-surface-container-lowest hover:border-outline-variant hover:bg-surface-container flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors active:scale-[0.99]"
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
                                <h4 class="text-on-surface truncate text-xs font-semibold">
                                  {childItem.title}
                                </h4>
                                <div class="flex items-center gap-1.5">
                                  <span class="text-on-surface-variant text-[10px]">
                                    {formatTimestamp(childItem.created_at)}
                                  </span>
                                  <button
                                    type="button"
                                    class="text-on-surface-variant hover:text-error rounded-full p-0.5 opacity-0 transition-opacity group-hover/item:opacity-100"
                                    onclick={(e) => handleClearSingle(e, childItem.id)}
                                    title="Clear notification"
                                    aria-label="Clear notification"
                                  >
                                    <TrashIcon class="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                              <p class="text-on-surface line-clamp-2 text-xs leading-relaxed">
                                {childItem.body}
                              </p>
                            </div>
                          </div>
                        </SwipeableRow>
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
