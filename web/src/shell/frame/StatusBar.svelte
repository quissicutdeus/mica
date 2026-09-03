<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { fade } from '@gos/sdk';
  import { formattedTime, formattedDate } from '../state/time';
  import { currentApp } from '../state/navigation';
  import { displayCharge } from '../state/charge';
  import { clampedSignalLevel } from '../state/signal';
  import { bluetoothEnabled } from '../state/bluetooth';
  import { musicSource, musicStatus } from '../state/music';
  import { clampProgress } from '../../lib/phone/pointerDrag';
  import { shadeDragRevealDistance, statusBarIconCap } from '../state/display';
  import { descriptor, frame } from '../state/device';
  import SignalIcon from '../../../../sdk/ui/icons/SignalIcon.svelte';
  import BluetoothIcon from '../../../../sdk/ui/icons/BluetoothIcon.svelte';
  import MusicNoteIcon from '../../../../sdk/ui/icons/MusicNoteIcon.svelte';
  import BatteryIcon from '../../../../sdk/ui/icons/BatteryIcon.svelte';
  import {
    openShade,
    isShadeOpen,
    closeShade,
    shadeDragProgress,
    shadeDragPhase
  } from '../state/shade';
  import { unreadCounts } from '../../services/notifications';
  import { badgeAllowed } from '../state/notificationPolicy';
  import { appRegistryStore } from '../state/registry';
  import { wallpaperNeedsContrast } from '../state/wallpaper';
  import { attachStatusBarDrag } from './frameGestures';

  /**
   * The status bar, out of `PhoneFrame.svelte` so the tablet's frame draws the same one
   * (MICA-259). Everything it shows is shell state it reads for itself; the one thing
   * that differs per device — how many notification icons fit before the `+N` chip — it
   * computes from the descriptor rather than takes as a prop.
   */

  let statusBarRef = $state<HTMLElement | null>(null);

  /**
   * Whether the status bar's text is being drawn onto the player's own photograph.
   *
   * `on-surface` against an arbitrary picture is a ratio nobody can state, which is
   * exactly the hazard `.text-on-wallpaper` exists for (MICA-109) and what `AppIcon`'s
   * label already uses. With the stroke, the clock is read against `surface` instead of
   * against the photo: 14.30:1 dark, 16.28:1 light, whatever the picture.
   *
   * Scoped to the home screen because an open app paints its own `surface` under this
   * bar, where the stroke would be a halo in the colour it already sits on — inert, but a
   * thing to reason about on every screen rather than on the one that needs it.
   * `$currentApp` is always an object (`{ id: 'home' }` when nothing is open), so this is
   * a check on the id and never a truthiness test.
   */
  const onWallpaper = $derived($wallpaperNeedsContrast && $currentApp.id === 'home');

  /**
   * Which apps' icons show in the status bar as a "you have something waiting" row —
   * one per app with an unread notification, not one per notification. Dereferences
   * `$appRegistryStore` directly rather than `.getManifest()` — see `Launcher.svelte`'s
   * own fix for why a one-shot `get()` read is the wrong tool here.
   */
  const pendingNotificationApps = $derived(
    Object.entries($unreadCounts)
      .filter(([, count]) => count > 0)
      // The same switch that governs a launcher badge governs this row: both are the
      // "something is waiting for you" indicator, and honouring one while ignoring the
      // other would leave a muted app still flagging itself in the status bar (MICA-63).
      .filter(([appId]) => $badgeAllowed(appId))
      .map(([appId]) => $appRegistryStore.find((app) => app.id === appId))
      .filter((app): app is NonNullable<typeof app> => Boolean(app))
  );

  /**
   * The row is drawn against a fixed run of pixels that ends at the hole-punch camera, so
   * it is capped and the remainder is counted rather than drawn (MICA-103). The cap and
   * the arithmetic behind it live in `state/display.ts` with the frame's other dimensions,
   * as a function of the frame: 3 on the phone, where the cutout is the limit, and more
   * on a frame with no cutout (MICA-258).
   *
   * The overflow chip is not itself in the budget when nothing overflows: at exactly the
   * cap there is no chip, so the row is shorter than the number was chosen for. That is the
   * right way round — the tight case is the one with the chip.
   *
   * **Music takes one of those slots rather than adding a fourth glyph (MICA-111).**
   *
   * The cap is a pixel budget with 3.8px of headroom, so "one more icon, only sometimes"
   * is not available at any price — a fourth glyph ends inside the hole-punch camera. What
   * is available is a slot: the row still draws at most the cap's worth of children before
   * the chip, so every measurement in `state/display.ts` holds unchanged and there is
   * nothing to re-derive.
   *
   * **Music is never the hidden one.** It is subtracted before the slice rather than
   * competing inside it, so what overflows into `+N` is always an unread app. A glyph
   * whose entire job is to say "this is still making noise while you are elsewhere" cannot
   * be the thing that gets counted instead of drawn; an unread app can, because the shade
   * is one pull away and the count says how many are down there.
   */
  const iconCap = $derived(statusBarIconCap($frame.width, $descriptor.chrome.holePunch));
  const musicSlots = $derived($musicSource ? 1 : 0);
  const visibleNotificationApps = $derived(pendingNotificationApps.slice(0, iconCap - musicSlots));
  const hiddenNotificationCount = $derived(
    pendingNotificationApps.length - visibleNotificationApps.length
  );

  /**
   * The Music app's own glyph, taken from the registry the way every other tray entry
   * takes its own — the owner asked for "the app icon", and this row is per-app icons.
   *
   * Read through `$appRegistryStore` rather than imported: the shell may not import out of
   * `apps/` (`sdk/boundary.test.ts`), and the registry is the sanctioned route it already
   * uses two derivations above. `MusicNoteIcon` stays as the fallback for a registry that
   * cannot answer — music is `core: true` so that should be unreachable, but a silent
   * blank is the one outcome this indicator must not have.
   */
  const musicIcon = $derived($appRegistryStore.find((app) => app.id === 'music')?.icon);

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

  // A plain `onMount` runs once and would miss the status bar entirely when it isn't
  // rendered yet at mount time (transparent mode, a dead battery) — both toggle after
  // mount, at which point `statusBarRef` changes without a remount. An `$effect` re-runs
  // its cleanup and re-attaches whenever the ref itself changes, so the gesture tracks
  // the button's actual lifetime instead of the component's.
  $effect(() => {
    if (!statusBarRef) return;
    return attachStatusBarDrag(statusBarRef, $shadeDragRevealDistance);
  });
</script>

<!-- `onWallpaper` below, on each text run and never on this button: `.text-on-wallpaper`
     is three inherited properties, and app.css spells out what putting it on a
     container costs — `paint-order` reaches SVG, so the stroke would land on the
     signal, bluetooth and battery glyphs as well as on the clock. Those are the one
     part of this bar the stroke technique cannot help; they stay `on-surface` over
     an unknown photo, and that is recorded in MICA-109 rather than papered over. -->
<button
  bind:this={statusBarRef}
  type="button"
  class="text-on-surface duration-short ease-standard text-body-medium absolute top-0 z-60 flex w-full cursor-pointer items-center justify-between px-8 pt-3 transition-opacity hover:opacity-90 active:opacity-75"
  onclick={() => ($isShadeOpen ? closeShade() : openShade())}
  aria-label={$isShadeOpen ? 'Close notification shade' : 'Open notification shade'}
>
  <div class="flex items-center gap-2">
    <span class:text-on-wallpaper={onWallpaper}>{$formattedTime}</span>
    {#if $isShadeOpen}
      <!-- Only once fully open, not mid-drag — a half-open bar reading "1:12 AM
           Thu, Aug 20" while the icons are also mid-fade would be two things
           changing size and content at once.

           `text-on-surface-variant`, not the `opacity-80` this carried (MICA-109).
           Dimming themed text with an opacity utility puts the glyph at a colour no
           token names and nothing measures: composited over the shade it came out at
           3.28:1 in light, under the 4.5 it needs. M3 has a second on-surface text
           role for exactly this job — "the same text, quieter" — and it is 8.06:1
           there. Same rule as the ban on opacity modifiers for role *backgrounds* in
           app.css, one utility further along. -->
      <span
        class="text-body-small text-on-surface-variant"
        class:text-on-wallpaper={onWallpaper}
        transition:fade={{ duration: 150 }}>{$formattedDate}</span
      >
    {/if}
    {#if pendingNotificationApps.length > 0 || $musicSource}
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
      <div
        data-testid="status-notification-icons"
        class="flex items-center gap-1"
        style="opacity: {pendingIconsOpacity}"
      >
        <!-- Music, and it is deliberately first (MICA-111).

             The icons after it are newest-first, which is an ordering music has no
             place in: it is ongoing rather than unread, so it has no arrival time to
             be sorted by and it would otherwise drift leftward through the row as
             older notifications cleared. Pinning it to the head gives it the one
             property the others cannot have — it is in the same place every time you
             look, which is what "still playing" needs to be readable at a glance.
             Adjacency to the clock says the same thing a second way: both are
             continuous state, and the icons past them are events.

             It fades with the rest of the row as the shade opens, unlike the battery
             and signal it used to sit beside. That is the tray's rule and it applies
             here for the tray's reason: what these icons point at is what the shade
             is about to show, and the shade's own now-playing card is a fuller
             version of this glyph exactly as the notification list is of the others.

             Shown whenever anything is loaded, paused included — `$musicSource` and
             never `$musicStatus === 'playing'`. The point of the glyph is that
             somebody who put the phone down can tell it still has music in hand, and
             where to go about it; a paused track is exactly that case.

             Three colours for three states, unchanged by the move. Playing inherits
             the bar's `text-on-surface`; paused is `text-on-surface-variant`, the
             "same text, quieter" role and never an opacity modifier on a themed role
             (§6); a refused track is `text-error` rather than dimmed, because dimmed
             is precisely what paused looks like and a failure that renders as a
             pause leaves somebody waiting for audio that is never coming. The charge
             percentage across the bar already turns `text-error` at 20%, so that is
             the bar's existing idiom for "something is wrong" and not a new one. -->
        {#if $musicSource}
          <span
            data-testid="status-music-indicator"
            class="flex items-center"
            class:text-on-surface-variant={$musicStatus === 'paused'}
            class:text-error={$musicStatus === 'error'}
          >
            {#if typeof musicIcon === 'string'}
              <img src={musicIcon} alt="" class="h-3.5 w-3.5 object-contain" />
            {:else if musicIcon}
              {@const MusicAppIcon = musicIcon}
              <MusicAppIcon class="h-3.5 w-3.5" />
            {:else}
              <MusicNoteIcon class="h-3.5 w-3.5" />
            {/if}
          </span>
        {/if}
        {#each visibleNotificationApps as app (app.id)}
          {#if typeof app.icon === 'string'}
            <img src={app.icon} alt="" class="h-3.5 w-3.5 object-contain" />
          {:else if app.icon}
            {@const Icon = app.icon}
            <Icon class="h-3.5 w-3.5" />
          {/if}
        {/each}
        {#if hiddenNotificationCount > 0}
          <!-- Counted, not drawn. `text-label-small` (11px) is the smallest step on
               the type scale and the only one that fits the remaining run before the
               cutout; it inherits the bar's own `text-on-surface` like the icons do,
               so it reads as one row rather than as a badge stuck on the end. -->
          <span class="text-label-small" class:text-on-wallpaper={onWallpaper}
            >+{hiddenNotificationCount}</span
          >
        {/if}
      </div>
    {/if}
  </div>
  <div class="flex items-center gap-2">
    {#if $bluetoothEnabled}
      <BluetoothIcon class="h-3.5 w-3.5 opacity-90" />
    {/if}
    <SignalIcon level={$clampedSignalLevel} />

    <div class="flex items-center gap-1.5">
      <span
        class="text-body-small"
        class:text-error={$displayCharge <= 20}
        class:text-on-wallpaper={onWallpaper}>{$displayCharge}%</span
      >
      <BatteryIcon class="h-3 w-6" charge={$displayCharge} />
    </div>
  </div>
</button>
