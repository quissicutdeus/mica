<script lang="ts">
  import { parseDeepLink } from '@shared/deepLink';
  import type { NotificationItem } from '@shared/types';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fade, fly } from 'svelte/transition';
  import { attachDragGesture } from '../lib/pointerDrag';
  import { createSheetClose } from '../lib/sheetDrag';
  import {
    groupNotificationsByConversation,
    type NotificationConversationGroup
  } from './lib/notificationGrouping';
  import Avatar from '../sdk/ui/Avatar.svelte';
  import AirplaneIcon from '../sdk/ui/icons/AirplaneIcon.svelte';
  import ArchiveIcon from '../sdk/ui/icons/ArchiveIcon.svelte';
  import BluetoothIcon from '../sdk/ui/icons/BluetoothIcon.svelte';
  import CheckIcon from '../sdk/ui/icons/CheckIcon.svelte';
  import ChevronDownIcon from '../sdk/ui/icons/ChevronDownIcon.svelte';
  import CloseIcon from '../sdk/ui/icons/CloseIcon.svelte';
  import FlashlightIcon from '../sdk/ui/icons/FlashlightIcon.svelte';
  import SignalIcon from '../sdk/ui/icons/SignalIcon.svelte';
  import TrashIcon from '../sdk/ui/icons/TrashIcon.svelte';
  import {
    clearAllNotifications,
    clearNotifications,
    loadNotificationHistory,
    loadShadeNotifications,
    loadUnreadCounts,
    markNotificationsOpened,
    restoreNotifications,
    shadeNotifications
  } from '../services/notifications';
  import { airplaneModeEnabled, toggleAirplaneMode } from './state/airplane';
  import { bluetoothEnabled, toggleBluetooth } from './state/bluetooth';
  import { SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import { flashlightEnabled, toggleFlashlight } from './state/flashlight';
  import { openApp } from './state/navigation';
  import { cellServiceEnabled, toggleCellService } from './state/signal';
  import { closeShade, isShadeOpen, shadeDragPhase, shadeDragProgress } from './state/shade';
  import SwipeableRow from './SwipeableRow.svelte';

  interface QuickToggle {
    label: string;
    icon: typeof SignalIcon;
    enabled: boolean;
    disabled?: boolean;
    onToggle: () => void;
  }

  let quickToggles = $derived<QuickToggle[]>([
    {
      label: 'Network',
      icon: SignalIcon,
      enabled: $cellServiceEnabled,
      disabled: $airplaneModeEnabled,
      onToggle: toggleCellService
    },
    {
      label: 'Bluetooth',
      icon: BluetoothIcon,
      enabled: $bluetoothEnabled,
      disabled: $airplaneModeEnabled,
      onToggle: toggleBluetooth
    },
    {
      label: 'Airplane',
      icon: AirplaneIcon,
      enabled: $airplaneModeEnabled,
      onToggle: toggleAirplaneMode
    },
    {
      label: 'Flashlight',
      icon: FlashlightIcon,
      enabled: $flashlightEnabled,
      onToggle: toggleFlashlight
    }
  ]);

  let notifications = $derived($shadeNotifications);

  interface NotificationGroup {
    app: string;
    items: NotificationItem[];
    latest: NotificationItem;
  }

  let groupedNotifications = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- scratch structure local to this computation; discarded once `groups` is built, nothing observes it
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
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- scratch structure local to this computation; discarded once `groups` is built, nothing observes it
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
    // Opened, not merely read: the card has done its job once it has been tapped, so it
    // leaves Active for Archived rather than sitting there already-actioned (MICA-96).
    // Unconditional — a card with no deep link is still acknowledged by the tap, and it
    // would otherwise be the one kind of notification a tap could never clear.
    await markNotificationsOpened([item.id]);
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

  /** Opening a conversation handles every message in it, not just the one tapped. */
  const handleConversationClick = async (convo: NotificationConversationGroup) => {
    await markNotificationsOpened(convo.items.map((i) => i.id));
    const link = convo.latest.deep_link ? parseDeepLink(convo.latest.deep_link) : null;
    if (link) {
      openApp(link.app, link.props);
      closeShade();
    }
  };

  const clearConversation = async (convo: NotificationConversationGroup) => {
    await clearNotifications(convo.items.map((i) => i.id));
  };

  const handleClearConversation = async (e: MouseEvent, convo: NotificationConversationGroup) => {
    e.stopPropagation();
    await clearConversation(convo);
  };

  const restoreConversation = async (convo: NotificationConversationGroup) => {
    const ids = convo.items.map((i) => i.id);
    await restoreNotifications(ids);
    historyItems = historyItems.filter((i) => !ids.includes(i.id));
  };

  const handleRestoreConversation = async (e: MouseEvent, convo: NotificationConversationGroup) => {
    e.stopPropagation();
    await restoreConversation(convo);
  };

  const handleClearAll = async () => {
    await clearAllNotifications();
  };

  let shadeElement = $state<HTMLElement | null>(null);
  let scrollContainerRef = $state<HTMLElement | null>(null);

  /**
   * The close-drag, shared with `AppDrawer.svelte` through `lib/sheetDrag.ts` — the same
   * gesture pointed the other way. Everything that used to be written out here (the
   * progress maths, the commit heuristic, the settle, and the rule that a body swipe
   * never arms on top of a `<button>`) lives there once, and `direction: 'up'` is what
   * makes this the shade rather than the drawer: closing pulls up, so the gesture frees
   * itself from the list only at its scroll *bottom*.
   */
  const closeDrag = createSheetClose({
    direction: 'up',
    progress: shadeDragProgress,
    phase: shadeDragPhase,
    revealDistance: SHADE_DRAG_REVEAL_DISTANCE,
    close: closeShade,
    scrollContainer: () => scrollContainerRef
  });

  $effect(() => {
    if (!shadeElement) return;
    return attachDragGesture(shadeElement, {
      axis: 'y',
      shouldStart: closeDrag.bodyShouldStart,
      onMove: closeDrag.onMove,
      onEnd: closeDrag.onEnd,
      onCancel: closeDrag.abandon
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
    bind:this={shadeElement}
    transition:fly={{ y: -850, duration: $shadeDragPhase === 'idle' ? 300 : 0 }}
    class="bg-surface-container-high text-on-surface shadow-elevation-5 absolute inset-0 z-55 flex h-full w-full flex-col pt-14 pb-2 backdrop-blur-3xl {$shadeDragPhase ===
    'settling'
      ? 'duration-medium ease-emphasized transition-transform'
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
    <!-- Header Bar -->
    <div class="mb-4 flex items-center justify-between px-6">
      <div class="flex items-baseline gap-2">
        <h2 class="text-on-surface text-lg font-bold tracking-tight">Notifications</h2>
        <span class="text-primary text-body-small tracking-wider uppercase">
          {showHistory ? 'Archive' : 'Active'}
        </span>
      </div>

      <div class="flex items-center gap-1.5">
        {#if !showHistory}
          {#if notifications.length > 0}
            <button
              type="button"
              class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-error duration-short ease-standard rounded-full p-2 transition-colors"
              onclick={handleClearAll}
              title="Clear all notifications"
              aria-label="Clear all notifications"
            >
              <TrashIcon class="size-icon-sm" />
            </button>
          {/if}

          <button
            type="button"
            class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-primary duration-short ease-standard rounded-full p-2 transition-colors"
            onclick={openHistory}
            title="Notification Archive"
            aria-label="Notification Archive"
          >
            <ArchiveIcon class="size-icon-sm" />
          </button>
        {:else}
          <button
            type="button"
            class="bg-surface-container text-primary ring-primary hover:bg-surface-container-high hover:text-primary duration-short ease-standard rounded-full p-2 ring-1 transition-colors"
            onclick={closeHistory}
            title="Back to Active Notifications"
            aria-label="Back to Active Notifications"
          >
            <ArchiveIcon class="size-icon-sm" />
          </button>
        {/if}

        <button
          type="button"
          class="bg-surface text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard rounded-full p-2 transition-colors"
          onclick={closeShade}
          title="Close"
          aria-label="Close notification shade"
        >
          <CloseIcon class="size-icon-sm" />
        </button>
      </div>
    </div>

    <!-- Quick Settings Tiles -->
    <div class="mb-4 flex items-center justify-between gap-2 px-6">
      {#each quickToggles as toggle (toggle.label)}
        <button
          type="button"
          class="duration-short ease-standard flex flex-1 flex-col items-center gap-1 rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 {toggle.enabled
            ? 'bg-primary-container text-on-primary-container'
            : 'bg-surface text-on-surface-variant hover:bg-surface-container'}"
          onclick={toggle.onToggle}
          disabled={toggle.disabled}
          title={toggle.label}
          aria-label={toggle.label}
          aria-pressed={toggle.enabled}
        >
          <toggle.icon class="size-icon-sm" />
          <span class="text-label-small truncate">{toggle.label}</span>
        </button>
      {/each}
    </div>

    <!-- Notification List Area -->
    <div bind:this={scrollContainerRef} class="flex-1 scrollbar-none overflow-y-auto px-5 pb-8">
      {#if showHistory}
        <!-- History List View -->
        {#if loadingHistory}
          <div
            class="text-on-surface-variant flex h-full flex-col items-center justify-center space-y-2"
          >
            <p class="text-body-medium">Loading archive...</p>
          </div>
        {:else if historyItems.length === 0}
          <div
            class="text-on-surface-variant flex h-full flex-col items-center justify-center space-y-3 text-center"
          >
            <div
              class="bg-surface ring-outline-variant flex h-14 w-14 items-center justify-center rounded-lg ring-1"
            >
              <ArchiveIcon class="text-on-surface-variant h-7 w-7" />
            </div>
            <div>
              <p class="text-on-surface text-body-medium">No Archive Yet</p>
              <p class="text-on-surface-variant text-body-small">
                Cleared notifications will appear here
              </p>
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
                    class="group border-outline-variant bg-surface hover:border-outline-variant hover:bg-surface shadow-elevation-3 duration-short ease-standard relative flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 opacity-90 backdrop-blur-md transition-all hover:opacity-100 active:scale-[0.99]"
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
                        <span class="text-primary text-body-small tracking-wide uppercase">
                          {item.app}
                        </span>
                        <div class="flex items-center gap-2">
                          <span class="text-on-surface-variant text-label-small">
                            {formatTimestamp(item.cleared_at ?? item.created_at)}
                          </span>
                          <button
                            type="button"
                            class="text-error hover:bg-surface-container hover:text-on-surface duration-short ease-standard shrink-0 rounded-full p-1 transition-all"
                            onclick={(e) => handleRestoreSingle(e, item.id)}
                            title="Restore to Active notifications"
                            aria-label="Restore to Active notifications"
                          >
                            <TrashIcon class="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <h3 class="text-on-surface text-body-medium truncate">
                        {item.title}
                      </h3>

                      <p class="text-on-surface text-body-small line-clamp-2 leading-relaxed">
                        {item.body}
                      </p>
                    </div>
                  </div>
                </SwipeableRow>
              {:else}
                <!-- Grouped Collapsible Archive Stack -->
                <div
                  class="border-outline-variant bg-surface shadow-elevation-4 rounded-lg border p-3.5 opacity-90 backdrop-blur-md hover:opacity-100"
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
                            <span class="text-primary text-body-small tracking-wide uppercase">
                              {group.app}
                            </span>
                            <span
                              class="bg-primary-container text-on-primary-container ring-primary text-label-small inline-flex items-center rounded-full px-2 py-0.5 ring-1"
                            >
                              {group.items.length} notifications
                            </span>
                          </div>
                          <div class="flex items-center gap-1.5">
                            <span class="text-on-surface-variant text-label-small">
                              {formatTimestamp(group.latest.cleared_at ?? group.latest.created_at)}
                            </span>
                            <button
                              type="button"
                              class="text-error hover:bg-surface-container hover:text-on-surface duration-short ease-standard rounded-full p-1 transition-colors"
                              onclick={(e) => handleRestoreGroup(e, group.app)}
                              title={`Restore all ${group.app} notifications`}
                              aria-label={`Restore all ${group.app} notifications`}
                            >
                              <TrashIcon class="h-3.5 w-3.5" />
                            </button>
                            <ChevronDownIcon
                              class="text-on-surface-variant duration-medium ease-emphasized size-icon-sm transition-transform {expandedHistoryGroups[
                                group.app
                              ]
                                ? 'text-primary rotate-180'
                                : ''}"
                            />
                          </div>
                        </div>

                        <h3 class="text-on-surface text-body-medium truncate">
                          {group.latest.title}
                        </h3>
                        <p class="text-on-surface-variant text-body-small line-clamp-1">
                          {group.latest.body}
                        </p>
                      </div>
                    </div>
                  </SwipeableRow>

                  <!-- Expanded Group Sub-items List — one row per conversation
                       (grouped by sender/title), not one per raw message. Twelve texts
                       from the same person show as a single row here, not twelve. -->
                  {#if expandedHistoryGroups[group.app]}
                    <div
                      transition:fly={{ y: -5, duration: 150 }}
                      class="border-outline-variant mt-3 space-y-2 border-t pt-2.5 pr-1 pl-2"
                    >
                      {#each groupNotificationsByConversation(group.items) as convo (convo.title)}
                        <SwipeableRow onCommit={() => restoreConversation(convo)}>
                          <div
                            class="group/item border-outline-variant bg-surface-container-lowest hover:border-outline-variant hover:bg-surface-container duration-short ease-standard flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors active:scale-[0.99]"
                            onclick={() => handleConversationClick(convo)}
                            role="button"
                            tabindex={0}
                            onkeydown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                void handleConversationClick(convo);
                              }
                            }}
                          >
                            <div class="min-w-0 flex-1 space-y-0.5">
                              <div class="flex items-center justify-between gap-2">
                                <div class="flex min-w-0 items-center gap-1.5">
                                  <h4 class="text-on-surface text-body-small truncate">
                                    {convo.title}
                                  </h4>
                                  {#if convo.items.length > 1}
                                    <span
                                      class="bg-primary-container text-on-primary-container ring-primary text-label-small inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 ring-1"
                                    >
                                      {convo.items.length}
                                    </span>
                                  {/if}
                                </div>
                                <div class="flex items-center gap-1.5">
                                  <span class="text-on-surface-variant text-label-small">
                                    {formatTimestamp(
                                      convo.latest.cleared_at ?? convo.latest.created_at
                                    )}
                                  </span>
                                  <button
                                    type="button"
                                    class="text-error hover:text-on-surface duration-short ease-standard rounded-full p-0.5 transition-colors"
                                    onclick={(e) => handleRestoreConversation(e, convo)}
                                    title="Restore to Active notifications"
                                    aria-label="Restore to Active notifications"
                                  >
                                    <TrashIcon class="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                              <p
                                class="text-on-surface text-body-small line-clamp-2 leading-relaxed"
                              >
                                {convo.latest.body}
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
              class="bg-surface ring-outline-variant shadow-elevation-2 flex h-16 w-16 items-center justify-center rounded-lg ring-1"
            >
              <CheckIcon class="h-8 w-8 text-emerald-400" />
            </div>
            <div>
              <p class="text-on-surface text-body-large">No New Notifications</p>
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
                    class="group border-outline-variant bg-surface hover:border-outline-variant hover:bg-surface shadow-elevation-3 duration-short ease-standard relative flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 backdrop-blur-md transition-all active:scale-[0.99]"
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
                        <span class="text-primary text-body-small tracking-wide uppercase">
                          {item.app}
                        </span>
                        <div class="flex items-center gap-2">
                          <span class="text-on-surface-variant text-label-small">
                            {formatTimestamp(item.created_at)}
                          </span>
                          <button
                            type="button"
                            class="text-on-surface-variant hover:bg-surface-container hover:text-error duration-short ease-standard shrink-0 rounded-full p-1 opacity-0 transition-all group-hover:opacity-100"
                            onclick={(e) => handleClearSingle(e, item.id)}
                            title="Clear notification"
                            aria-label="Clear notification"
                          >
                            <TrashIcon class="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <h3 class="text-on-surface text-body-medium truncate">
                        {item.title}
                      </h3>

                      <p class="text-on-surface text-body-small line-clamp-2 leading-relaxed">
                        {item.body}
                      </p>
                    </div>
                  </div>
                </SwipeableRow>
              {:else}
                <!-- Grouped Collapsible App Stack -->
                <div
                  class="border-outline-variant bg-surface shadow-elevation-4 rounded-lg border p-3.5 backdrop-blur-md"
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
                            <span class="text-primary text-body-small tracking-wide uppercase">
                              {group.app}
                            </span>
                            <span
                              class="bg-primary-container text-on-primary-container ring-primary text-label-small inline-flex items-center rounded-full px-2 py-0.5 ring-1"
                            >
                              {group.items.length} notifications
                            </span>
                          </div>
                          <div class="flex items-center gap-1.5">
                            <span class="text-on-surface-variant text-label-small">
                              {formatTimestamp(group.latest.created_at)}
                            </span>
                            <button
                              type="button"
                              class="text-on-surface-variant hover:bg-surface-container hover:text-error duration-short ease-standard rounded-full p-1 transition-colors"
                              onclick={(e) => handleClearGroup(e, group.app)}
                              title={`Clear all ${group.app} notifications`}
                              aria-label={`Clear all ${group.app} notifications`}
                            >
                              <TrashIcon class="h-3.5 w-3.5" />
                            </button>
                            <ChevronDownIcon
                              class="text-on-surface-variant duration-medium ease-emphasized size-icon-sm transition-transform {expandedGroups[
                                group.app
                              ]
                                ? 'text-primary rotate-180'
                                : ''}"
                            />
                          </div>
                        </div>

                        <h3 class="text-on-surface text-body-medium truncate">
                          {group.latest.title}
                        </h3>
                        <p class="text-on-surface-variant text-body-small line-clamp-1">
                          {group.latest.body}
                        </p>
                      </div>
                    </div>
                  </SwipeableRow>

                  <!-- Expanded Group Sub-items List — one row per conversation
                       (grouped by sender/title), not one per raw message. Twelve texts
                       from the same person show as a single row here, not twelve. -->
                  {#if expandedGroups[group.app]}
                    <div
                      transition:fly={{ y: -5, duration: 150 }}
                      class="border-outline-variant mt-3 space-y-2 border-t pt-2.5 pr-1 pl-2"
                    >
                      {#each groupNotificationsByConversation(group.items) as convo (convo.title)}
                        <SwipeableRow onCommit={() => clearConversation(convo)}>
                          <div
                            class="group/item border-outline-variant bg-surface-container-lowest hover:border-outline-variant hover:bg-surface-container duration-short ease-standard flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors active:scale-[0.99]"
                            onclick={() => handleConversationClick(convo)}
                            role="button"
                            tabindex={0}
                            onkeydown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                void handleConversationClick(convo);
                              }
                            }}
                          >
                            <div class="min-w-0 flex-1 space-y-0.5">
                              <div class="flex items-center justify-between gap-2">
                                <div class="flex min-w-0 items-center gap-1.5">
                                  <h4 class="text-on-surface text-body-small truncate">
                                    {convo.title}
                                  </h4>
                                  {#if convo.items.length > 1}
                                    <span
                                      class="bg-primary-container text-on-primary-container ring-primary text-label-small inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 ring-1"
                                    >
                                      {convo.items.length}
                                    </span>
                                  {/if}
                                </div>
                                <div class="flex items-center gap-1.5">
                                  <span class="text-on-surface-variant text-label-small">
                                    {formatTimestamp(convo.latest.created_at)}
                                  </span>
                                  <button
                                    type="button"
                                    class="text-on-surface-variant hover:text-error duration-short ease-standard rounded-full p-0.5 opacity-0 transition-opacity group-hover/item:opacity-100"
                                    onclick={(e) => handleClearConversation(e, convo)}
                                    title="Clear conversation"
                                    aria-label="Clear conversation"
                                  >
                                    <TrashIcon class="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                              <p
                                class="text-on-surface text-body-small line-clamp-2 leading-relaxed"
                              >
                                {convo.latest.body}
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
