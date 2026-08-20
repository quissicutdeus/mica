<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { fly, fade } from 'svelte/transition';
  import { formattedTime, formattedDate } from './state/time';
  import { goHome } from './state/navigation';
  import { displayCharge, isBatteryDead } from './state/charge';
  import { clampedSignalLevel } from './state/signal';
  import { bluetoothEnabled } from './state/bluetooth';
  import { stepVolume } from './state/audio';
  import { enableDragScroll } from '../lib/dragScroll';
  import { attachDragGesture, clampProgress, shouldCommitDrag } from '../lib/pointerDrag';
  import { PHONE_HEIGHT, PHONE_WIDTH, SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import LightningWarningIcon from '../sdk/ui/icons/LightningWarningIcon.svelte';
  import SignalIcon from '../sdk/ui/icons/SignalIcon.svelte';
  import BluetoothIcon from '../sdk/ui/icons/BluetoothIcon.svelte';
  import BatteryIcon from '../sdk/ui/icons/BatteryIcon.svelte';
  import VolumeHud from './VolumeHud.svelte';
  import NotificationShade from './NotificationShade.svelte';
  import DragGhost from './DragGhost.svelte';
  import {
    openShade,
    isShadeOpen,
    closeShade,
    shadeDragProgress,
    shadeDragPhase
  } from './state/shade';
  import { unreadCounts } from '../services/notifications';
  import { appRegistryStore } from './state/registry';
  import { wallpaperBackground } from './state/wallpaper';
  import { themeStyleStore } from './state/theme';

  let { transparent = false, onClose, children } = $props();
  let screenElement = $state<HTMLElement | null>(null);
  let statusBarRef = $state<HTMLElement | null>(null);
  const wallpaper = $derived($wallpaperBackground);
  const themeStyle = $derived($themeStyleStore);

  /**
   * Which apps' icons show in the status bar as a "you have something waiting" row —
   * one per app with an unread notification, not one per notification, and capped at 5
   * so a busy phone can't push the clock into the hole-punch camera. Dereferences
   * `$appRegistryStore` directly rather than `.getManifest()` — see `Launcher.svelte`'s
   * own fix for why a one-shot `get()` read is the wrong tool here.
   */
  const pendingNotificationApps = $derived(
    Object.entries($unreadCounts)
      .filter(([, count]) => count > 0)
      .map(([appId]) => $appRegistryStore.find((app) => app.id === appId))
      .filter((app): app is NonNullable<typeof app> => Boolean(app))
      .slice(0, 5)
  );

  /**
   * Live pull-down progress, whether the shade is settled or mid-drag — mirrors
   * `NotificationShade.svelte`'s own `effectiveProgress`, which drives the sheet's
   * `translateY` the same way. Drives the notification-icon row's fade below: those
   * icons exist to say "something is waiting" before the shade is open, so they have
   * nothing left to say once the real notifications are the thing on screen, and fading
   * across the first half of the pull (rather than snapping at the end) reads as making
   * room for them rather than a checkbox flipping.
   */
  const shadeProgress = $derived(
    $shadeDragPhase === 'idle' ? ($isShadeOpen ? 1 : 0) : $shadeDragProgress
  );
  const pendingIconsOpacity = $derived(clampProgress(1 - shadeProgress * 2));

  onMount(() => {
    if (screenElement) {
      return enableDragScroll(screenElement);
    }
  });

  // A plain `onMount` runs once and would miss the status bar entirely when it isn't
  // rendered yet at mount time (transparent mode, a dead battery) — both toggle after
  // mount, at which point `statusBarRef` changes without a remount. An `$effect` re-runs
  // its cleanup and re-attaches whenever the ref itself changes, so the gesture tracks
  // the button's actual lifetime instead of the component's.
  $effect(() => {
    if (!statusBarRef) return;
    return attachDragGesture(statusBarRef, {
      axis: 'y',
      onMove: (deltaY) => {
        if (get(isShadeOpen)) return;
        shadeDragPhase.set('dragging');
        shadeDragProgress.set(clampProgress(deltaY / SHADE_DRAG_REVEAL_DISTANCE));
      },
      onEnd: (deltaY, velocity) => {
        if (get(isShadeOpen)) return;
        shadeDragPhase.set('settling');
        if (shouldCommitDrag(get(shadeDragProgress), velocity)) {
          shadeDragProgress.set(1);
          openShade();
        } else {
          shadeDragProgress.set(0);
        }
      }
    });
  });
</script>

<!-- Phone Frame.

     The fill is conditional, not just the screen's. `transparent` used to be applied
     only to the inner screen div while this one kept an unconditional `bg-gray-950` —
     near-black and fully opaque — so the camera viewfinder rendered as a black box in
     game no matter what the screen did. The bezel border stays either way; it is the
     phone body, not the display.

     Always the design size, from `state/display.ts`. The zoom is a `transform` on a
     wrapper in `Shell.svelte` and deliberately not here: `transition:fly` writes
     `transform` on this element, so a scale set alongside it would be overwritten for
     the duration of every open and close. -->
<div
  transition:fly={{ y: 1000, duration: 500 }}
  data-testid="phone-frame"
  style="width: {PHONE_WIDTH}px; height: {PHONE_HEIGHT}px;"
  class="shadow-elevation-5 duration-medium ease-emphasized rounded-frame-outer relative border-[8px] border-gray-950 ring-1 ring-gray-600 transition-colors"
  class:bg-gray-950={!transparent || $isBatteryDead}
>
  <!-- Hardware Side Buttons -->
  <!-- Power / Screen Off Button -->
  <button
    class="duration-short ease-standard absolute top-[180px] -right-[13px] h-12 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600"
    onclick={onClose}
    title="Power / Screen Off"
    aria-label="Power / Screen Off"
  ></button>

  <!-- Volume Buttons -->
  <div class="absolute top-[250px] -right-[13px] flex flex-col gap-2">
    <button
      class="duration-short ease-standard h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(1)}
      disabled={$isBatteryDead}
      title="Volume Up"
      aria-label="Volume Up"
    ></button>
    <button
      class="duration-short ease-standard h-10 w-[5px] cursor-pointer rounded-r-md bg-gray-800 transition-colors hover:bg-gray-700 active:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-800 disabled:active:bg-gray-800"
      onclick={() => stepVolume(-1)}
      disabled={$isBatteryDead}
      title="Volume Down"
      aria-label="Volume Down"
    ></button>
  </div>

  <!-- Screen.

       Also the theme root: `themeStyle` writes all 47 `--color-*` roles here as inline
       custom properties, and they inherit into every app inside. It has to be this
       element rather than the frame or the document — the bezel above is the physical
       phone body and stays outside the theme, and touching `document.documentElement`
       would leak across jsdom test files and need teardown.

       There is no `bg-*` fallback class. One used to sit here as
       `class:bg-gray-900={… && !activeWallpaper}`, which never applied: it tested a
       `$derived` object for falsiness. The opaque fill in normal mode comes from the
       wallpaper, and a `bg-surface` here would be worse than dead — it would occlude the
       game world behind the camera viewfinder in transparent mode.

       The wallpaper is one CSS value on one property. It used to be a Tailwind class for a
       preset and an inline `background` for anything else, chosen by a ternary on the
       wallpaper's `type` — which meant the class had to survive Tailwind's scanner (a
       renamed preset silently rendered nothing) and, worse, `from-cyan-900` compiles to
       `oklch()` inside a gradient with no hex fallback, so those presets would not have
       rendered in game at all. -->
  <div
    bind:this={screenElement}
    data-testid="phone-screen"
    class="rounded-frame-inner duration-medium ease-emphasized relative h-full w-full overflow-hidden transition-colors"
    style={`${!transparent && !$isBatteryDead ? `background: ${wallpaper};` : ''} ${themeStyle}`}
    class:bg-black={$isBatteryDead}
    class:bg-transparent={transparent && !$isBatteryDead}
  >
    <!-- On-Screen Volume HUD Overlay -->
    <VolumeHud />

    <!-- Notification Shade Overlay -->
    <NotificationShade />

    <!-- Drag ghost: renders above every layer regardless of which surface (App Drawer,
         home grid, dock, folder popup) started the drag. -->
    <DragGhost />

    <!-- Dead Phone Screen Overlay -->
    {#if $isBatteryDead}
      <div
        class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black p-6 text-white"
      >
        <!-- Large Blinking Low Battery Icon -->
        <div class="relative flex animate-pulse flex-col items-center justify-center gap-6">
          <!-- Battery Outer Container -->
          <div
            class="relative flex h-14 w-28 items-center justify-start rounded-lg border-4 border-red-500/80 p-1.5 shadow-[0_0_20px_rgba(239,68,68,0.3)]"
          >
            <!-- Battery Nipple -->
            <div
              class="absolute top-1/2 -right-3.5 h-6 w-2.5 -translate-y-1/2 rounded-r-md bg-red-500/80"
            ></div>
            <!-- Low Battery Red Bar (blinking empty state) -->
            <div class="h-full w-2 rounded-sm bg-red-500"></div>
            <!-- Lightning Cable Warning Icon overlay -->
            <div class="absolute inset-0 flex items-center justify-center">
              <LightningWarningIcon />
            </div>
          </div>
          <div class="flex flex-col items-center gap-1.5 text-center">
            <span class="text-body-small tracking-wider text-red-400 uppercase">Battery Low</span>
            <span class="text-[11px] font-light text-gray-400">Connect Battery Bank</span>
          </div>
        </div>
      </div>
    {/if}

    <!-- Status Bar -->
    {#if !transparent && !$isBatteryDead}
      <button
        bind:this={statusBarRef}
        type="button"
        class="text-on-surface duration-short ease-standard text-body-medium absolute top-0 z-60 flex w-full cursor-pointer items-center justify-between px-8 pt-3 transition-opacity hover:opacity-90 active:opacity-75"
        onclick={() => ($isShadeOpen ? closeShade() : openShade())}
        aria-label={$isShadeOpen ? 'Close notification shade' : 'Open notification shade'}
      >
        <div class="flex items-center gap-2">
          <span>{$formattedTime}</span>
          {#if $isShadeOpen}
            <!-- Only once fully open, not mid-drag — a half-open bar reading "1:12 AM
                 Thu, Aug 20" while the icons are also mid-fade would be two things
                 changing size and content at once. -->
            <span class="text-body-small opacity-80" transition:fade={{ duration: 150 }}
              >{$formattedDate}</span
            >
          {/if}
          {#if pendingNotificationApps.length > 0}
            <!-- Monochrome, matching the status bar's own `text-on-surface` — an app's
                 own tile color (`AppIcon`'s `bg-*` background) would be too busy at this
                 size and would drift from the rest of the bar the moment a wallpaper
                 forced light-on-dark text. Icons using `currentColor` (most of them)
                 pick this up for free; one hardcoded to a fixed color — Snek — will not,
                 the same tradeoff its own launcher tile already made deliberately.

                 `class="h-3.5 w-3.5"` on the icon itself, matching `BluetoothIcon` —
                 every app icon component now accepts and honors `class` (they didn't
                 all used to; a couple were a bare `<svg class="h-8 w-8">` with nothing
                 plumbed through, which is what this repo has instead of Tailwind, so a
                 mismatched class token is not a build error, just silently inert — the
                 real fix was making every icon component take the prop, not papering
                 over the ones that didn't with a wrapper trick this hand-written
                 utility layer doesn't support in the first place).

                 Opacity tracks the shade's own pull progress rather than just its open/
                 closed state — these icons exist to say "something is waiting" before
                 the shade is open, so they fade out across the first half of the pull,
                 clear of the way by the point the real notifications start being
                 legible underneath. -->
            <div class="flex items-center gap-1" style="opacity: {pendingIconsOpacity}">
              {#each pendingNotificationApps as app (app.id)}
                {#if typeof app.icon === 'string'}
                  <img src={app.icon} alt="" class="h-3.5 w-3.5 object-contain" />
                {:else if app.icon}
                  {@const Icon = app.icon}
                  <Icon class="h-3.5 w-3.5" />
                {/if}
              {/each}
            </div>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          {#if $bluetoothEnabled}
            <BluetoothIcon class="h-3.5 w-3.5 opacity-90" />
          {/if}
          <SignalIcon level={$clampedSignalLevel} />

          <div class="flex items-center gap-1.5">
            <span class="text-body-small" class:text-error={$displayCharge <= 20}
              >{$displayCharge}%</span
            >
            <BatteryIcon class="h-3 w-6" charge={$displayCharge} />
          </div>
        </div>
      </button>
    {/if}

    <!-- Hole Punch Camera. `z-80` — above every other layer in the shell, including the
         shade/drawer sheets (`z-55`) and the drag ghost (`z-70`), the current highest.
         It stands for a hole physically cut in the screen: nothing in the UI can ever
         cover a real one, so nothing here should be able to either — it used to sit at
         `z-30`, under the shade, and visibly vanished under its sheet as the shade was
         dragged down.

         `pointer-events-none` is what a real cutout gets for free and this one has to be
         told: it sits dead center of the status bar, exactly where a tap or the start of
         a drag-down-to-open-the-shade is likely to land, and once it was stacked above
         that button (rather than below it, as `z-30` left it) a plain `<div>` there
         would otherwise silently absorb the touch instead of letting it reach the
         button underneath. -->
    <div
      class="size-icon-lg pointer-events-none absolute top-2 left-1/2 z-80 -translate-x-1/2 rounded-full bg-black ring-1 ring-gray-800"
    ></div>

    <!-- Content Area -->
    {#if !$isBatteryDead}
      <div class="h-full">
        {@render children()}
      </div>
    {/if}

    <!-- Home Indicator Gesture Bar.

         The label names the one action the press will actually perform, rather than
         listing both. It briefly read "Return to home screen or collapse notifications",
         which is worse on both counts: a screen reader hears a disjunction it has to
         resolve itself, and four e2e specs match this attribute exactly and silently
         stopped finding the button. Same shape as the status bar above.

         `h-6` centered gives the pill even clearance from the screen edge below and
         `Dock` above, now that `Dock` sits at `bottom-10` rather than crowding this
         bar at `bottom-6`. -->
    <button
      class="absolute bottom-0 left-0 z-50 flex h-6 w-full cursor-pointer items-center justify-center"
      onclick={() => {
        if ($isShadeOpen) {
          closeShade();
        } else {
          goHome();
        }
      }}
      aria-label={$isShadeOpen ? 'Collapse notifications' : 'Return to home screen'}
    >
      <div
        class="duration-medium ease-emphasized h-1 w-1/3 rounded-full bg-white/80 transition-colors hover:bg-white"
      ></div>
    </button>
  </div>
</div>
