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

  let handleRef = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!handleRef) return;
    return attachDragGesture(handleRef, {
      axis: 'y',
      onMove: (deltaY) => {
        drawerDragPhase.set('dragging');
        // Dragging down closes: deltaY grows positive, progress (1 = open) counts back
        // down toward 0 as the pull continues — mirrors NotificationShade's own handle.
        drawerDragProgress.set(clampProgress(1 - deltaY / SHADE_DRAG_REVEAL_DISTANCE));
      },
      onEnd: (_deltaY, velocity) => {
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

  <div
    transition:fly={{ y: 850, duration: $drawerDragPhase === 'idle' ? 300 : 0 }}
    class="bg-surface-container-high text-on-surface shadow-elevation-5 absolute inset-0 z-55 flex h-full w-full flex-col pt-14 pb-2 backdrop-blur-3xl {$drawerDragPhase ===
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
    <div class="mb-4 px-6">
      <h2 class="text-on-surface text-lg font-bold tracking-tight">Apps</h2>
    </div>

    <div class="flex-1 scrollbar-none overflow-y-auto px-6 pb-10">
      <div class="grid grid-cols-4 gap-y-6">
        {#each visibleApps as app (app.id)}
          <div use:attachIcon={app.id}>
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

    <!-- Grab Handle, styled and positioned to match NotificationShade's own — a single
         white pill at the bottom of the screen regardless of which overlay is open. -->
    <button
      type="button"
      bind:this={handleRef}
      class="absolute bottom-0 left-0 z-10 flex h-6 w-full cursor-pointer touch-none items-end justify-center pb-1.5"
      data-gesture-drag
      data-testid="drawer-grab-handle"
      onclick={closeDrawer}
      aria-hidden="true"
      tabindex="-1"
    >
      <div
        class="duration-medium ease-emphasized h-1 w-1/3 rounded-full bg-white opacity-80 transition-opacity hover:opacity-100"
      ></div>
    </button>
  </div>
{/if}
