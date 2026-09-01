<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { badgeAllowed } from './state/notificationPolicy';
  import { get } from 'svelte/store';
  import { fade, fly, focusTrap } from '@gphone/sdk';
  import { attachDragGesture } from '../lib/phone/pointerDrag';
  import { createSheetClose } from '../lib/phone/sheetDrag';
  import { attachLongPressDrag } from '../lib/phone/longPressDrag';
  import AppIcon from '../../../sdk/ui/AppIcon.svelte';
  import AppIconTile from '../../../sdk/ui/AppIconTile.svelte';
  import SearchIcon from '../../../sdk/ui/icons/SearchIcon.svelte';
  import { isAdmin } from '../services/admin';
  import { capabilities } from '../services/capabilities';
  import { appVisible } from './state/appVisibility';
  import { contacts } from '../services/contacts';
  import { conversationsStore } from '../services/conversations';
  import { appRegistryStore } from './state/registry';
  import { SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import {
    closeDrawer,
    isDrawerOpen,
    drawerDragPhase,
    drawerDragProgress,
    searchQuery
  } from './state/appDrawer';
  import { searchEverything, type SearchResult } from './state/searchResults';
  import {
    iconDragState,
    resolveDropAtPoint,
    resolveIconDrop,
    startIconDrag,
    moveIconDrag
  } from './state/iconDrag';

  /** Two-arg `openApp` (not the Dock's single-arg one) — search results deep-link. */
  let { openApp } = $props<{
    openApp: (id: string, props?: Record<string, unknown>) => void;
  }>();

  /**
   * The registry itself is already alphabetical (`registry.ts`'s sort comparator), but the
   * drawer sorts defensively rather than trusting that invariant silently — cheap insurance
   * if the registry's own sort ever changes for a reason unrelated to this feature.
   */
  let visibleApps = $derived(
    [...$appRegistryStore]
      .filter((app) => $appVisible(app))
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  /**
   * Search never fetches. It reads the same three stores the apps themselves read, and it
   * can do that because Contacts and Messages both declare a `preload` in their manifests
   * that `bootstrapStores` runs when the phone opens — so both lists are already populated
   * before the home screen paints, whether or not the player has ever opened those apps.
   */
  const results = $derived(
    searchEverything(
      $searchQuery,
      { apps: $appRegistryStore, contacts: $contacts, conversations: $conversationsStore },
      { isAdmin: $isAdmin, capabilities: $capabilities }
    )
  );

  /**
   * Group headers are derived from the result order rather than stored on each result:
   * `searchEverything` already guarantees apps-then-contacts-then-messages, so a header
   * belongs exactly where a result's kind differs from its predecessor's.
   */
  const GROUP_LABEL: Record<SearchResult['kind'], string> = {
    app: 'Apps',
    contact: 'Contacts',
    message: 'Messages'
  };

  function launch(result: SearchResult) {
    closeDrawer();
    if (result.kind === 'app') {
      openApp(result.id);
    } else if (result.kind === 'contact') {
      openApp('contacts', { initialContact: result.contact });
    } else {
      openApp('messages', { conversationId: result.conversationId });
    }
  }

  let topHandleRef = $state<HTMLElement | null>(null);
  let scrollContainerRef = $state<HTMLElement | null>(null);
  let drawerElement = $state<HTMLElement | null>(null);
  let inputRef = $state<HTMLInputElement | null>(null);

  /** Always focused on open, however it opened — typing to filter needs no extra tap. */
  $effect(() => {
    if ($isDrawerOpen && inputRef) inputRef.focus({ preventScroll: true });
  });

  /**
   * The close-drag, shared with `NotificationShade.svelte` through `lib/sheetDrag.ts` —
   * the same gesture pointed the other way. `direction: 'down'` is what makes this the
   * drawer: closing pulls down, so the body swipe frees itself from the icon grid only at
   * its scroll *top*, which is what keeps it from stealing a scroll already in progress
   * (or an icon's own long-press-to-pick-up — see `bodyShouldStart` there).
   *
   * Wired to two surfaces below: the top pill, and the drawer body itself.
   */
  const closeDrag = createSheetClose({
    direction: 'down',
    progress: drawerDragProgress,
    phase: drawerDragPhase,
    revealDistance: SHADE_DRAG_REVEAL_DISTANCE,
    close: closeDrawer,
    scrollContainer: () => scrollContainerRef
  });

  $effect(() => {
    if (!topHandleRef) return;
    return attachDragGesture(topHandleRef, {
      axis: 'y',
      crossAxisCancel: false,
      onMove: closeDrag.onMove,
      onEnd: closeDrag.onEnd,
      onCancel: closeDrag.abandon
    });
  });

  $effect(() => {
    if (!drawerElement) return;
    return attachDragGesture(drawerElement, {
      axis: 'y',
      shouldStart: (e) =>
        !(e.target as HTMLElement | null)?.closest('input') && closeDrag.bodyShouldStart(e),
      onMove: closeDrag.onMove,
      onEnd: closeDrag.onEnd,
      onCancel: closeDrag.abandon
    });
  });

  /** Fallback in case an overshoot drag leaves no `transitionend` to flip this back
   * (MICA-45) — mirrors `NotificationShade.svelte`'s identical timer. */
  $effect(() => {
    if ($drawerDragPhase !== 'settling') return;
    const timeout = setTimeout(() => {
      if (get(drawerDragPhase) === 'settling') drawerDragPhase.set('idle');
    }, 250);
    return () => clearTimeout(timeout);
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
    class="bg-surface-container-high text-on-surface shadow-elevation-5 rounded-t-xl absolute inset-x-0 top-10 bottom-0 z-55 flex flex-col pt-10 pb-2 backdrop-blur-3xl {$drawerDragPhase ===
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
    use:focusTrap
    role="dialog"
    aria-modal="true"
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

    <!-- Empty query shows the app grid below; typing swaps it for a filtered list. -->
    <div class="mb-4 px-4">
      <!-- The ring is on the pill, not on the `<input>` (MICA-109). The input keeps its
           own `outline-none`: an outline traces the *input's* box, which is a bare
           rectangle sitting inside this rounded-full container, so the focus affordance
           would be a rectangle in a pill. `focus-within` moves it out to the shape the
           player actually sees, the same way `ToastHost`'s reply field does it. -->
      <div
        class="bg-surface-container-highest text-on-surface focus-within:ring-focus-ring flex h-11 shrink-0 items-center gap-2 rounded-full px-4 focus-within:ring-1"
      >
        <SearchIcon class="text-on-surface-variant h-4 w-4" />
        <input
          bind:this={inputRef}
          bind:value={$searchQuery}
          type="text"
          class="text-body-medium placeholder:text-on-surface-variant w-full bg-transparent outline-none"
          placeholder="Search apps, contacts and messages"
          aria-label="Search apps, contacts and messages"
        />
      </div>
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
      {#if !$searchQuery.trim()}
        <div class="grid grid-cols-4 gap-y-6">
          {#each visibleApps as app (app.id)}
            <div use:attachIcon={app.id} class="flex items-center justify-center">
              <AppIcon
                name={app.name}
                badgeSuppressed={!$badgeAllowed(app.id)}
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
      {:else if results.length === 0}
        <p class="text-on-surface-variant text-body-medium px-2 py-6 text-center">
          No results for "{$searchQuery.trim()}"
        </p>
      {:else}
        {#each results as result, index (result.key)}
          {#if index === 0 || results[index - 1].kind !== result.kind}
            <h2 class="text-primary text-label-small px-2 pt-3 pb-1 tracking-wider uppercase">
              {GROUP_LABEL[result.kind]}
            </h2>
          {/if}
          <button
            type="button"
            onclick={() => launch(result)}
            class="hover:bg-surface-container-highest duration-short ease-standard flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors"
          >
            <!-- An app shows its own tile colour and glyph; a contact or a conversation has
                 no icon of its own, so it gets a neutral monogram rather than borrowing some
                 other app's identity. -->
            {#if result.kind === 'app'}
              <AppIconTile
                name={result.manifest.name}
                icon={result.manifest.icon}
                color={result.manifest.color}
                size="sm"
              />
            {:else}
              <div
                class="bg-surface-container-highest text-on-surface-variant text-label-large flex h-9 w-9 shrink-0 items-center justify-center rounded-full uppercase"
              >
                {result.title.trim().charAt(0) || '?'}
              </div>
            {/if}
            <div class="min-w-0 flex-1">
              <p class="text-body-medium truncate">{result.title}</p>
              <p class="text-on-surface-variant text-body-small truncate">{result.subtitle}</p>
            </div>
          </button>
        {/each}
      {/if}
    </div>

    <!-- No bottom grab handle here, deliberately. This sheet's `bottom-0` edge lands on
         the exact same pixels as `PhoneFrame.svelte`'s real "Return to home screen"
         indicator underneath, and a second pill sliding in there on open/close read as
         that real, permanently-fixed control moving — it never does; the drawer's own
         opaque sheet was just covering it and animating a look-alike on top. Closing is
         still reachable three other ways: the top pill below, a swipe down starting
         anywhere on the body (gated by `closeDrag.bodyShouldStart`), and a tap on the scrim. -->
  </div>
{/if}
