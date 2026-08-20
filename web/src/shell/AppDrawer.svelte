<script lang="ts">
  import { get } from 'svelte/store';
  import { fade, fly } from 'svelte/transition';
  import { attachDragGesture, clampProgress, shouldCommitDrag } from '../lib/pointerDrag';
  import { attachLongPressDrag } from '../lib/longPressDrag';
  import AppIcon from '../sdk/ui/AppIcon.svelte';
  import { isAdmin } from '../services/admin';
  import { appRegistryStore } from './state/registry';
  import { SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import {
    closeDrawer,
    isDrawerOpen,
    drawerDragPhase,
    drawerDragProgress
  } from './state/appDrawer';
  import {
    iconDragState,
    resolveDropAtPoint,
    resolveIconDrop,
    startIconDrag,
    moveIconDrag
  } from './state/iconDrag';

  let { openApp } = $props<{ openApp: (id: string) => void }>();

  /**
   * The registry itself is already alphabetical (`registry.ts`'s sort comparator), but the
   * drawer sorts defensively rather than trusting that invariant silently — cheap insurance
   * if the registry's own sort ever changes for a reason unrelated to this feature.
   */
  let visibleApps = $derived(
    [...$appRegistryStore]
      .filter((app) => !app.requiresAdmin || $isAdmin)
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  let topHandleRef = $state<HTMLElement | null>(null);
  let scrollContainerRef = $state<HTMLElement | null>(null);
  let drawerElement = $state<HTMLElement | null>(null);

  /**
   * Shared close-drag behavior, wired to two surfaces below: the top pill and the
   * drawer body itself — no bottom handle (see the note by the body's closing tag for
   * why). The body attach is gated by `bodyDragShouldStart` so it never steals a scroll
   * in progress inside the icon grid — see that function for why.
   */
  function onCloseDragMove(deltaY: number) {
    drawerDragPhase.set('dragging');
    // Dragging down closes: deltaY grows positive, progress (1 = open) counts back
    // down toward 0 as the pull continues — mirrors NotificationShade's own handle.
    drawerDragProgress.set(clampProgress(1 - deltaY / SHADE_DRAG_REVEAL_DISTANCE));
  }

  function onCloseDragEnd(_deltaY: number, velocity: number) {
    drawerDragPhase.set('settling');
    const closingProgress = 1 - get(drawerDragProgress);
    const closingVelocity = velocity;
    if (shouldCommitDrag(closingProgress, closingVelocity)) {
      drawerDragProgress.set(0);
      closeDrawer();
    } else {
      drawerDragProgress.set(1);
    }
  }

  /**
   * The icon grid scrolls (mouse-drag-to-scroll via `enableDragScroll`, same axis as this
   * close gesture), so a drag starting mid-scroll must not also try to close the drawer —
   * that's the exact conflict `NotificationShade` avoided by only ever wiring its handle.
   * Gating on `scrollTop <= 0` lets a downward drag close only when there's nothing left
   * to scroll up into; an upward drag while already at the top just harmlessly re-commits
   * to progress 1 (still open), since there's no further scrolling for it to compete with.
   *
   * Also refuses to arm on top of a `<button>` — every icon is one, and without this an
   * icon's own long-press-to-pick-up (`attachLongPressDrag`, wired to the icon itself)
   * and this whole-body close-swipe (wired to `drawerElement`, which the icon sits
   * inside) both start tracking the *same* pointerdown via bubbling. Dragging an icon
   * out is `axis: 'y'` movement too, so this gesture's own axis-lock could commit before
   * the long-press timer ever fires, steal pointer capture, and then spring the drawer
   * back open on release — undoing the `closeDrawer()` the long-press had already
   * called. A drag genuinely meant to close still works from any empty space between or
   * below the icons.
   */
  function bodyDragShouldStart(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return false;
    return !scrollContainerRef || scrollContainerRef.scrollTop <= 0;
  }

  $effect(() => {
    if (!topHandleRef) return;
    return attachDragGesture(topHandleRef, {
      axis: 'y',
      onMove: onCloseDragMove,
      onEnd: onCloseDragEnd
    });
  });

  $effect(() => {
    if (!drawerElement) return;
    return attachDragGesture(drawerElement, {
      axis: 'y',
      shouldStart: bodyDragShouldStart,
      onMove: onCloseDragMove,
      onEnd: onCloseDragEnd
    });
  });

  function attachIcon(node: HTMLElement, appId: string) {
    const detach = attachLongPressDrag(node, {
      onLongPress: (e) => {
        const manifest = appRegistryStore.getManifest(appId) ?? null;
        closeDrawer();
        startIconDrag(appId, { kind: 'drawer' }, e.clientX, e.clientY, manifest);
      },
      onDragMove: (x, y) => moveIconDrag(x, y),
      onDragEnd: (x, y) => {
        resolveIconDrop(get(iconDragState), resolveDropAtPoint(x, y));
      },
      onDragCancel: () => {
        // A tap under holdMs — let the click handler below open the app as usual.
      }
    });
    return { destroy: detach };
  }
</script>

{#if $isDrawerOpen || $drawerDragPhase !== 'idle'}
  {@const effectiveProgress =
    $drawerDragPhase === 'idle' ? ($isDrawerOpen ? 1 : 0) : $drawerDragProgress}

  <div
    transition:fade={{ duration: 200 }}
    class="bg-scrim absolute inset-0 z-40 backdrop-blur-sm"
    onclick={closeDrawer}
    role="presentation"
  ></div>

  <!-- `top-10` rather than full-bleed (`inset-0`, what this used to be): unlike
       NotificationShade, which is meant to read as the status bar's own surface extended
       down, the drawer is a bottom sheet — it should stop short of the status bar and hole-
       punch camera rather than climb all the way to the top of the phone. Mirrors Dock's own
       `bottom-10` clearance from the opposite edge. `rounded-t-xl` follows from the same
       change: a sheet with a real top edge gets the M3 dialog/bottom-sheet radius there,
       where `inset-0` had no exposed corner to round. -->
  <div
    bind:this={drawerElement}
    transition:fly={{ y: 850, duration: $drawerDragPhase === 'idle' ? 300 : 0 }}
    class="bg-surface-container-high text-on-surface shadow-elevation-5 rounded-t-xl absolute inset-x-0 top-10 bottom-0 z-55 flex flex-col pt-12 pb-2 backdrop-blur-3xl {$drawerDragPhase ===
    'settling'
      ? 'duration-medium ease-emphasized transition-transform'
      : ''}"
    style="transform: translateY({(1 - effectiveProgress) * 850}px)"
    ontransitionend={(e) => {
      if (
        e.target === e.currentTarget &&
        e.propertyName === 'transform' &&
        $drawerDragPhase === 'settling'
      ) {
        drawerDragPhase.set('idle');
      }
    }}
    role="dialog"
    aria-label="App Drawer"
  >
    <!-- Top pill — the one grab handle this drawer has, at the edge it travels away
         from on close. There is no matching one at the bottom; see the note by the
         body's closing tag for why a second pill there is the wrong move here even
         though `NotificationShade.svelte` mirrors this same idea at its own far edge. -->
    <button
      type="button"
      bind:this={topHandleRef}
      class="absolute top-0 left-0 z-10 flex h-6 w-full cursor-pointer touch-none items-start justify-center pt-3"
      data-gesture-drag
      data-testid="drawer-top-handle"
      onclick={closeDrawer}
      aria-hidden="true"
      tabindex="-1"
    >
      <div
        class="duration-medium ease-emphasized h-1 w-8 rounded-full bg-white opacity-80 transition-opacity hover:opacity-100"
      ></div>
    </button>

    <div class="mb-6 flex items-baseline gap-2 px-6">
      <h2 class="text-on-surface text-title-large">Apps</h2>
      <span class="text-primary text-body-small tracking-wider uppercase">
        {visibleApps.length}
        {visibleApps.length === 1 ? 'app' : 'apps'}
      </span>
    </div>

    <!-- `pt-2`: `AppIcon`'s unread badge overhangs `-top-1` above the icon tile itself, and
         this container clips via `overflow-y-auto` right at its own top edge — with no
         padding there, the first row's badges got their tips cut off flush against that
         boundary, which read as the header text overlapping them but was really the
         scroll clip. -->
    <div
      bind:this={scrollContainerRef}
      class="flex-1 scrollbar-none overflow-y-auto px-4 pt-2 pb-10"
    >
      <!-- `px-4`, not `px-6` — matches `Launcher.svelte`'s own outer padding (and, through
           it, `Dock.svelte`'s), so an icon opened from the drawer lands under the same
           column it would occupy on the home grid rather than a few px to the right of it.
           Each cell centers its icon explicitly (`flex items-center justify-center`), the
           same as `Launcher.svelte`'s own grid cells — without it an icon narrower than its
           1fr track sits flush against the track's left edge instead of centered in it. -->
      <div class="grid grid-cols-4 gap-y-6">
        {#each visibleApps as app (app.id)}
          <div use:attachIcon={app.id} class="flex items-center justify-center">
            <AppIcon
              name={app.name}
              color={app.color}
              icon={app.icon}
              badgeStore={app.badgeStore}
              onclick={() => {
                closeDrawer();
                openApp(app.id);
              }}
            />
          </div>
        {/each}
      </div>
    </div>

    <!-- No bottom grab handle here, deliberately. This sheet's `bottom-0` edge lands on
         the exact same pixels as `PhoneFrame.svelte`'s real "Return to home screen"
         indicator underneath, and a second pill sliding in there on open/close read as
         that real, permanently-fixed control moving — it never does; the drawer's own
         opaque sheet was just covering it and animating a look-alike on top. Closing is
         still reachable three other ways: the top pill below, a swipe down starting
         anywhere on the body (gated by `bodyDragShouldStart`), and a tap on the scrim. -->
  </div>
{/if}
