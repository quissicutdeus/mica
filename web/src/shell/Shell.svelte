<!--
SPDX-FileCopyrightText: 2025 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from './messages';
  import { hydrateSettings } from '../../../sdk/host/useStorage';
  import { migrateAppDrawerHintForExistingSaves } from './state/onboarding';
  import { appRegistryStore } from './state/registry';
  import { loadRemoteAppConfig } from './state/remoteAppConfig';
  import { refreshCapabilities } from '../services/capabilities';
  import { createNuiMessageRouter } from './nuiMessages';
  import { installDevHarness, seedBrowserPhone } from './devHarness';
  import { isBrowser } from '@gphone/sdk';
  import { currentApp, runningApps, openApp, goHome, closePhone } from './state/navigation';
  import { dispatchKey, isTypingTarget, registerHandler } from './state/keybinds';
  import { findAction } from '@gphone/shared/keybinds';
  import { lockDevTools } from './state/devtools';
  import {
    frameMargin,
    observeViewport,
    phoneBox,
    phoneScale,
    viewportSize,
    PHONE_HEIGHT,
    PHONE_WIDTH
  } from './state/display';
  import { get } from 'svelte/store';
  import { callStore } from '../services/call';
  import type { CallStatus } from '../../../sdk/vocabulary/call';
  import { contacts } from '../services/contacts';
  import { isPreviewingPhoto } from '../services/camera';
  import PhoneFrame from './PhoneFrame.svelte';
  import Home from './Launcher.svelte';
  import Dock from './Dock.svelte';
  import AppDrawer from './AppDrawer.svelte';
  import Search from './Search.svelte';
  import { fetchNui } from '../nui/fetchNui';
  import { toast } from './state/toast';
  import { callBreaksThrough } from './state/notificationPolicy';
  import { bootstrapStores } from './state/bootstrap';
  import ToastContainer from './ToastHost.svelte';
  import ErrorBoundary from './ErrorBoundary.svelte';
  import NotNetworkScreen from './NotNetworkScreen.svelte';
  import HostProvider from '../../../sdk/HostProvider.svelte';
  import { hostForApp } from '../../../sdk/host/inProcess/createInProcessHost';
  import { installSystemHost } from '../../../sdk/host/inProcess/system';
  import { clampedSignalLevel } from './state/signal';
  import { audio } from './state/audio';
  import { isPhoneOpen } from './state/phoneOpen';
  import { isLightMode } from './state/theme';
  import { observeReducedMotion } from './state/motion';
  import AddOnFrame from './addon/AddOnFrame.svelte';
  import MusicPlayer from './MusicPlayer.svelte';
  import NearbyMusicPlayer from './NearbyMusicPlayer.svelte';
  import ClosedPhoneNotification from './ClosedPhoneNotification.svelte';
  import { isTrustedNuiSource } from './nuiGuard';
  import { installMusicBroadcast } from '../services/music';
  import { evaluateLockOnOpen, noteLockScreenClosed } from './state/lockScreen';
  import { refreshPasscodeStatus } from '../services/passcode';

  installSystemHost();

  // Tell the server what this phone is playing out loud, so the people standing next to it
  // hear it (MICA-111 phase 2). Installed here rather than imported for its side effect:
  // `services/music.ts` exports nothing else, and an import that looks unused is what a
  // tidy-up deletes. It watches shell state and is never called again.
  installMusicBroadcast();

  /**
   * The phone starts closed everywhere, including a dev browser, and is opened by
   * something — the client's `setVisible`, or the harness below.
   *
   * This used to be `$state(isBrowser())`, which read as harmless: in game
   * `window.invokeNative` exists, so `isBrowser()` is false and the phone starts
   * closed. But it is evaluated once, at module-init, and it is only true that CEF has
   * injected `invokeNative` *by then* if the bundle happens to evaluate after the
   * injection. Lose that race and the phone starts `visible` in game — which is
   * MICA-86, by a route that has nothing to do with the animation itself.
   *
   * `PhoneFrame`'s `transition:fly` is a **local** transition, and a local transition
   * does not play on initial render (`main.ts` mounts with no `intro` option, and even
   * `intro: true` does not change this for a local one). So a phone that starts open
   * has its frame created at initial render, silently, with no fly-in. `setVisible: true`
   * on the player's first open then finds `visible` already true, creates no block, and
   * so runs no transition — the phone appears instantly instead of sliding up. Seeding
   * `false` puts the frame's creation back on the actual open, where the intro plays.
   *
   * The browser has no client to send `setVisible`, so it opens itself in `onMount`
   * below — deliberately after initial render, so the dev browser exercises the same
   * block-creation path the game does rather than a second, untested one.
   */
  let visible = $state(false);

  /**
   * The page behind the phone, in a dev browser only — never in CEF.
   *
   * In game this stays fully transparent (§5/§6): the phone overlays the game world, and
   * any background here would paint over it. In a browser there is no game world behind
   * it, just the tab's default white, which `isBrowser()` is exactly the right guard to
   * distinguish. Follows the player's own light/dark choice (`isLightMode`) rather than
   * `prefers-color-scheme` — matching the phone rather than the OS is more useful here,
   * since the point is comparing the two.
   *
   * Neutral grays, not the phone's own surface tokens: the bezel is a fixed near-black
   * (`border-gray-950`) regardless of theme, so the canvas has to stay lighter than that
   * in both modes or the frame disappears into it.
   */
  $effect(() => {
    if (!isBrowser()) return;
    document.documentElement.dataset.previewTheme = $isLightMode ? 'light' : 'dark';
  });

  $effect(() => {
    if (visible) audio.warm();
  });

  /**
   * `toast.ts` cannot see this component's own `visible` rune — it is not a module — so
   * this is the one line that keeps `state/phoneOpen.ts`'s mirror honest. MICA-141's
   * closed-phone peek is the one thing today that needs to know open/closed from outside
   * `Shell.svelte` at all.
   */
  $effect(() => {
    isPhoneOpen.set(visible);
  });

  /**
   * MICA-60: whether the lock screen greets the next open, decided fresh every time
   * `visible` actually changes rather than at each of the several places that flip it
   * (the dev-browser keybind, the real `setVisible` message, the notification-tap path)
   * — one effect that cannot be forgotten at a fourth call site later.
   */
  $effect(() => {
    if (visible) {
      evaluateLockOnOpen();
    } else {
      noteLockScreenClosed();
    }
  });

  /**
   * Everything that is not shell state is routed away.
   *
   * Only two cases stay: frame visibility, and the call status that owns the ring
   * toast's id. Both act on state that lives in this component, so passing them out
   * would be more coupling rather than less.
   */
  const routeNuiMessage = createNuiMessageRouter({
    openFromNotification: (appName, props) => {
      visible = true;
      openApp(appName, props);
    }
  });

  const handleMessage = (event: MessageEvent) => {
    // Real CEF's `SendNUIMessage` arrives with a null/undefined `source`, and the dev
    // harness posts its fixtures from `window` itself; anything else — an add-on
    // frame's `contentWindow`, in particular — is refused here. A sandboxed add-on's
    // only legitimate door into the shell is `IframeHostServer`, not this listener.
    if (!isTrustedNuiSource(event)) return;

    const { action, data } = (event.data ?? {}) as { action?: string; data?: unknown };

    if (action === 'setVisible') {
      visible = data as boolean;
      if (visible) audio.warm();
      if (!visible && isFreelook) isFreelook = false;
      // Developer Tools are earned per session, so closing the phone puts them back
      // behind the ten taps.
      if (!visible) lockDevTools();
      return;
    }

    if (action === 'callStatus') {
      const call = data as { status: CallStatus; number: string; name?: string };
      if (call.status === 'incoming') {
        // The client has no address book to check — that lives in the web layer's own
        // contacts store — so it sends 'Unknown' and this is the one place that can
        // still resolve a name from the caller's number before the toast renders.
        const known = get(contacts).find((c) => c.phone === call.number);
        const displayName = known ? `${known.firstname} ${known.lastname || ''}`.trim() : call.name;
        callStore.setIncoming(call.number, displayName);
        // Called exactly once per ring, and it records as well as reports — a second call
        // for the same ring would read back the timestamp this one wrote and count itself
        // as the repeat (`state/notificationPolicy.ts`).
        const breakThrough = callBreaksThrough(call.number);
        incomingToastId = toast.showCall({
          name: displayName,
          number: call.number,
          breakThrough,
          onAccept: () => {
            visible = true;
            openApp('phone');
            // Answer it, rather than merely opening the app on top of a still-ringing
            // call. `registerHandler('answerCall')` below has always done this; the
            // toast's own Accept button did not, so picking up from the ring left the
            // status on 'incoming', started no duration timer, and never sent
            // `answerCall` to the server — which then logged the call as *missed* with a
            // zero duration, since `answeredAt` was never set (`server/services/Phone.ts`).
            callStore.answerCall();
            // `ToastHost` dismisses a toast once its action resolves, and a plain dismiss
            // deliberately leaves the row it created in the shade. That is right for a
            // call nobody picked up and wrong for this one: archiving clears the
            // notification too, so an answered call stops sitting in the drawer as though
            // it still needed attention.
            if (incomingToastId) {
              void toast.archive(incomingToastId);
              incomingToastId = null;
            }
          },
          onDecline: declineCall,
          // Nothing else ends an unanswered call, so letting the toast simply vanish
          // left the phone open and focused with status stuck on 'incoming'. Treat the
          // timeout as a decline, which also tells the server to tear the call down.
          onExpire: declineCall
        });
      } else {
        // The server has moved the call on; a still-visible ring toast is stale.
        if (incomingToastId) {
          toast.dismiss(incomingToastId);
          incomingToastId = null;
        }
        callStore.setStatus(call.status);
      }
      return;
    }

    routeNuiMessage(event);
  };

  let isFreelook = false;
  let incomingToastId: string | null = null;

  const declineCall = () => {
    const { number } = $callStore;
    callStore.setStatus('idle');
    fetchNui('rejectCall', { number }).catch(() => {});
  };

  // Shell-level actions. Apps claim their own through `useKeybinds().onKeybind`, so this
  // file stays unaware of which apps exist or what keys they want.
  //
  // Calls are handled here rather than in the Phone app because an incoming call
  // force-opens the phone to whatever app was last on screen, and the call toast is
  // shell-level — the Phone app is usually not mounted when the ring arrives.
  registerHandler('answerCall', () => {
    if (incomingToastId) {
      toast.dismiss(incomingToastId);
      incomingToastId = null;
    }
    visible = true;
    openApp('phone');
    callStore.answerCall();
  });

  registerHandler('endCall', () => {
    if (incomingToastId) {
      toast.dismiss(incomingToastId);
      incomingToastId = null;
    }
    if ($callStore.status === 'incoming') {
      declineCall();
    } else {
      callStore.endCall();
    }
  });

  // The shell's fallback, underneath anything a mounted app claims. An app that has
  // its own levels handles those first and only lets this run at its top.
  registerHandler('back', () => {
    if ($currentApp.id !== 'home') {
      goHome();
    } else {
      closePhone();
    }
  });

  // Always lowers the phone, from anywhere. Deliberately not "back at the top level":
  // there is no state in which this does something else.
  registerHandler('closePhone', () => {
    if (isBrowser()) visible = false;
    closePhone();
  });

  const setFreelook = (state: boolean) => {
    if (isFreelook === state) return;
    isFreelook = state;
    fetchNui('toggleFreelook', { state });
  };

  registerHandler('freelook', () => {
    if (!visible) return;
    setFreelook(!isFreelook);
  });

  /**
   * Settings are fetched here, at page load, and deliberately not in `bootstrapStores`.
   *
   * `bootstrapStores` runs from an effect gated on `visible` — when the phone is *opened*.
   * Hydrating there means the phone paints with the shipped theme and flips to the
   * player's a beat later, in front of them. The CEF page loads at resource start with the
   * phone closed, so asking here gives the fetch the whole time before first open.
   *
   * Not awaited: the stores already hold the cached values, so the phone is usable either
   * way and re-reads itself when the answer lands.
   */
  onMount(() => {
    void hydrateSettings().then(() => migrateAppDrawerHintForExistingSaves());
  });

  /**
   * Whether a passcode exists at all, asked for here for the same reason settings are
   * above: `evaluateLockOnOpen` (MICA-60) reads it synchronously the moment `visible`
   * turns true, and the browser's own first open can follow mount within one tick — so
   * this has to already be in flight, not started by that same effect.
   */
  onMount(() => {
    void refreshPasscodeStatus();
  });

  /**
   * The operator's remote add-on convars, asked for here for the same reason settings are
   * (MICA-126).
   *
   * Earlier than `bootstrapStores` on purpose, and it has to be: the answer decides which
   * hosts may ship code into this phone, and `registry.ts` cannot re-verify a saved remote
   * install until it has one. Waiting for the phone to be *opened* would mean an add-on the
   * player installed last session was missing from the launcher they are looking at.
   *
   * Not awaited, like the hydrate above — a phone with no configured catalog is the normal
   * case and is fully usable, so nothing here is worth blocking first paint on.
   */
  onMount(() => {
    void loadRemoteAppConfig();
  });

  /**
   * What this server can actually do, asked for here for exactly the reason above.
   *
   * `bootstrapStores` asks too, and has to — a character switch re-runs it and the answer
   * can differ. But it is gated on the phone being *opened*, and this answer decides
   * whether Bank and Hodlr have icons at all: `services/capabilities.ts` starts denied in
   * game on purpose, so waiting for first open would mean painting the launcher without
   * them and adding them a beat later, in front of the player. Asking at mount gives the
   * request the whole time between resource start and first open; the in-flight promise in
   * that module means the two callers cost one request rather than two.
   */
  onMount(() => {
    void refreshCapabilities();
  });

  /**
   * The dev browser's stand-in for `openPhone` on the client.
   *
   * In game the phone is opened by `setVisible`; a browser has no client to send one, so
   * without this the page would load to the "Open gPhone" button and every e2e spec would
   * have to click it first. Opening here rather than seeding `visible = true` above is the
   * point of the exercise: `onMount` runs after initial render, so the frame is created by
   * a state change and its `transition:fly` actually plays — the same path the game takes.
   *
   * `mount()` is synchronous and `onMount` callbacks run inside it, so this lands before
   * the browser's first paint; the button above is never visibly on screen.
   */
  onMount(() => {
    if (isBrowser()) visible = true;
  });

  /**
   * The keydown body, shared by the real `window` listener and `handleFrameKey` below.
   *
   * `typing` is passed through explicitly rather than re-derived from `event.target`:
   * a key forwarded from an add-on's iframe carries a synthetic event whose target is
   * never a real focused field in *this* document, so the frame's own `onTyping` report
   * is the only thing that can answer that question for it.
   */
  function routeKey(event: KeyboardEvent, typing: boolean) {
    // Held keys must not repeat-fire an action; the old Alt branch special-cased this
    // and nothing else did.
    if (event.repeat) return;

    /**
     * Browser only: honor the Open Phone binding here.
     *
     * That action is `scope: 'game'`, so in game it is a `RegisterKeyMapping` the
     * client owns and the web never sees it. There is no FiveM in a browser, so
     * nothing was listening at all and a collapsed phone could only be reopened with
     * the mouse.
     *
     * Checked before `dispatchKey` because a collapsed phone has no meaningful
     * phone-scope action, and after the typing guard so it cannot fire out from under
     * a focused field.
     *
     * Reads the default straight off `KEYBIND_ACTIONS` rather than the `bindings`
     * store: `bindings` only resolves phone-scope actions (see keybinds.ts), and
     * `openPhone` is game-scope — its rebind path is FiveM's own Key Bindings menu,
     * never this store, so there is no override to look up here.
     */
    if (isBrowser() && !typing) {
      const openKey = findAction('openPhone')?.defaultKey;
      if (openKey && event.key.toLowerCase() === openKey.toLowerCase()) {
        event.preventDefault();
        if (visible) {
          visible = false;
          closePhone();
        } else {
          visible = true;
        }
        return;
      }
    }

    dispatchKey(
      event,
      {
        currentApp: $currentApp.id,
        callStatus: $callStore.status
      },
      typing
    );
  }

  /**
   * Tell the client when a text field has focus.
   *
   * The client cannot see DOM focus, and `RegisterKeyMapping` bindings would otherwise
   * still fire while typing — reachable today via freelook, which enables
   * `SetNuiFocusKeepInput`. Typing `MM` into a message would insert two characters and
   * toggle the phone twice.
   *
   * Hoisted out of the `onMount` below so the template can also reach it, for an
   * add-on's own `onTyping` report (`AddOnFrame`'s frame has no real DOM focus event
   * of its own to drive `handleFocusIn`/`handleFocusOut`).
   */
  const reportTyping = (typing: boolean) => fetchNui('setTyping', { typing }).catch(() => {});

  /**
   * Keys forwarded from an add-on's sandboxed iframe, over the host protocol rather
   * than a real DOM event — the frame has no access to this document's `window` to
   * dispatch one directly. Rebuilt as a `KeyboardEvent` so `routeKey` can stay the one
   * place that knows how a keypress becomes an action, for both origins.
   */
  function handleFrameKey(k: {
    key: string;
    code: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    typing: boolean;
  }) {
    // `cancelable: true` so `routeKey`'s `event.preventDefault()` (a claimed press) is
    // a real, checkable no-op rather than silently doing nothing on an event that can
    // never be canceled — nothing here reads it back, but a caller that later does
    // (or a test asserting `defaultPrevented`) should see the same contract the real
    // `window` keydown gives it.
    const event = new KeyboardEvent('keydown', {
      key: k.key,
      code: k.code,
      ctrlKey: k.ctrlKey,
      shiftKey: k.shiftKey,
      altKey: k.altKey,
      metaKey: k.metaKey,
      cancelable: true
    });
    routeKey(event, k.typing);
  }

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => routeKey(event, isTypingTarget(event.target));

    const handleFocusIn = (e: FocusEvent) => {
      if (isTypingTarget(e.target)) reportTyping(true);
    };
    const handleFocusOut = (e: FocusEvent) => {
      if (isTypingTarget(e.target)) reportTyping(false);
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);

    // Unconditional, rather than only on the effect above that fires when the phone is
    // first opened (MICA-141): a notification arriving before the player has ever opened
    // the phone this session used to reach an `AudioContext` nobody had resumed yet, so
    // CEF's autoplay restriction could leave the very first arrival silent even though
    // every policy check said it should chime.
    audio.warm();

    // Sized from a measured viewport rather than `100vh` — see `state/display.ts` for why
    // that unit is wrong in a mobile browser and why `dvh` is not available to us.
    const stopObservingViewport = observeViewport();
    // Publishes `data-reduced-motion` on the document, which `app.css` and `lib/motion.ts`
    // both read. Not guarded by `isBrowser()`: the whole point is that it applies in game,
    // where the player's own setting is the only reliable answer (`state/motion.ts`).
    const stopObservingMotion = observeReducedMotion();

    seedBrowserPhone(new Date());
    installDevHarness();

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
      stopObservingViewport();
      stopObservingMotion();
    };
  });

  $effect(() => {
    if (visible) {
      bootstrapStores();
    }
  });

  /**
   * Never leave focus inside an app that has just been backgrounded.
   *
   * Leaving an app by pressing Back means the app's own back button is still focused
   * when the shell makes its container `inert`, which strands the caret in a subtree
   * that is both `display:none` and unreachable. Blurring puts it back on the document,
   * so the next Tab starts from the top of whatever is now on screen.
   *
   * Scoped to focus that actually ended up inert, rather than blurring on every
   * navigation — opening an app from the launcher should not steal focus from anything.
   */
  $effect(() => {
    void $currentApp.id;
    const focused = document.activeElement as HTMLElement | null;
    if (focused?.closest('[inert]')) focused.blur();
  });

  // Track if we are currently in the camera app and notify the client
  let wasInCameraApp = false;
  $effect(() => {
    const isCameraApp = $currentApp.id === 'camera' && visible;
    if (isCameraApp === wasInCameraApp) return;
    wasInCameraApp = isCameraApp;
    fetchNui('onCameraApp', { state: isCameraApp });

    /**
     * Aim mode: freelook on for as long as the camera app is open.
     *
     * A camera you cannot point is not much of a camera, and framing a shot previously
     * meant holding the freelook key the whole time. Freelook already solves the only
     * hard part — `SetNuiFocus(true, false)` drops the cursor so the mouse turns the
     * view instead of moving a pointer, which is the one way to have both.
     *
     * The trade is that the on-screen controls are unclickable while aiming, so the
     * shutter and back run off their keybinds and the freelook key toggles the cursor
     * back for the mode tabs and the gallery.
     *
     * Set here rather than in the camera module because `isFreelook` is shell state:
     * leaving it stale would make the player's first freelook press a no-op.
     */
    setFreelook(isCameraApp);
  });
</script>

<!-- Outside `{#if visible}`, and that is the whole point of it being here.

     Everything in that block — the frame, `ToastContainer`, every resident app — is
     destroyed when the player lowers the phone. Music is expected to keep playing when the
     phone is down (MICA-111), so the element producing it cannot live anywhere the close
     tears down. It renders nothing at all until something is loaded, and is invisible when
     it is; `MusicPlayer.svelte` carries the reasoning, including why it is a bare
     cross-origin iframe rather than YouTube's own script. -->
<MusicPlayer />

<!-- Other people's, and it has to be out here for a stronger reason than your own does:
     you asked for your track, and nobody asked for theirs. A broadcast audible only while
     the phone was open would be a boombox you had to hold up to hear.
     `NearbyMusicPlayer.svelte` renders one player per audible broadcaster and nothing when
     nobody nearby is playing. -->
<NearbyMusicPlayer />

<!-- The closed-phone peek (MICA-141): the one thing besides the two players above still
     rendered once `visible` tears `PhoneFrame` — and `ToastHost` with it — down. Reads
     `toast.ts`'s own `closedPhoneToast` store, so there is nothing here for `Shell.svelte`
     to feed it beyond the `isPhoneOpen` mirror above. -->
<ClosedPhoneNotification />

{#if !visible && isBrowser()}
  <button
    onclick={() => (visible = true)}
    class="shadow-elevation-5 duration-short ease-standard text-body-small fixed right-4 bottom-4 z-[9999] flex cursor-pointer items-center gap-2 rounded-box border border-gray-700 bg-gray-900/90 px-4 py-2 text-white backdrop-blur-md transition-all hover:bg-gray-800"
  >
    <span class="relative flex h-2 w-2">
      <span
        class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
      ></span>
      <span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
    </span>
    {$t('shell.openPhone')}
  </button>
{/if}

{#if visible}
  <!-- The window, and the phone's place in it.

       Width and height are measured pixels, not `w-screen h-screen`: `100vh` in a mobile
       browser is the viewport with the URL bar retracted, so a phone anchored to the
       bottom of it hangs below the fold, and `dvh` — the unit that fixes that — needs
       Chromium 108 against a CEF baseline of 103 (AGENTS.md §6). The padding is the same
       number `fitScale` subtracted, so what fits is what is drawn. -->
  <main
    class="flex overflow-hidden"
    style="width: {$viewportSize.width}px; height: {$viewportSize.height}px; padding: {$frameMargin}px;"
    class:items-center={$currentApp.id === 'camera'}
    class:justify-center={$currentApp.id === 'camera'}
    class:items-end={$currentApp.id !== 'camera'}
    class:justify-end={$currentApp.id !== 'camera'}
    class:bg-transparent={true}
  >
    <!-- Two elements, because a transform is invisible to layout: the outer box is the
         size the phone actually occupies so the flex anchoring is right, and the inner one
         stays at the design size and is scaled from its top-left corner into it. -->
    <div
      class="relative shrink-0"
      style="width: {$phoneBox.width}px; height: {$phoneBox.height}px;"
    >
      <div
        class="absolute top-0 left-0 origin-top-left"
        style="width: {PHONE_WIDTH}px; height: {PHONE_HEIGHT}px; transform: scale({$phoneScale});"
      >
        <PhoneFrame
          transparent={$currentApp.id === 'camera' && !$isPreviewingPhoto}
          onClose={() => {
            if (isBrowser()) {
              visible = false;
            }
            closePhone();
          }}
        >
          <ToastContainer />
          <!-- Every resident app is mounted; only the active one is visible.

               Keyed by name so Svelte reuses the instance instead of tearing it down —
               that reuse *is* the state preservation.

               Inactive apps are `display:none`, not `visibility:hidden`. Visibility was the
               first choice, to keep them laid out and their scroll offset guaranteed — but
               in game the outgoing app stayed partly on screen over the home screen. These
               apps are full of `backdrop-blur`, `transform` and `hover:scale`, each of which
               promotes an element to its own compositor layer, and a hidden *ancestor* does
               not reliably force those layers to repaint on CEF's Chromium 103. Removing the
               box leaves nothing to retain.

               Scroll survives it: `display:none` preserves scrollTop in Chromium, which the
               residency e2e asserts rather than assumes.

               `inert` is what keeps them out of the tab order and the accessibility tree.
               Their DOM is still present and matchable — that is inherent to residency, and
               why tests here use role-based locators.

               `inert` and nothing else. It carried `aria-hidden` too, which is what `inert`
               already implies, and the pair is invalid the instant focus is inside: pressing
               Back leaves focus on the app's own back button, and Chrome refuses to hide a
               subtree containing the focused element. The console said so on every trip
               home. -->
          <div class="relative h-full w-full">
            {#if $currentApp.id === 'home'}
              <Home {openApp} />
              <Dock {openApp} />
              <Search />
              <AppDrawer {openApp} />
            {/if}

            {#each $runningApps as instance (instance.id)}
              {@const AppComponent = appRegistryStore.getComponent(instance.id)}
              {@const isActive = $currentApp.id === instance.id}
              {@const manifest = appRegistryStore.getManifest(instance.id)}
              {@const isNetworkBlocked =
                (manifest?.requiresNetwork ?? false) && $clampedSignalLevel === 0}
              {@const isAddOn = !!manifest && !manifest.core && !AppComponent}
              <!-- Backgrounded in-process apps get `display:none`; add-on frames must not.
                   An iframe with no box has a 0x0 viewport, and the sandbox document is a
                   `height:100%` chain (`srcdoc.ts`) — so `display:none` collapses the whole
                   add-on to nothing, and CEF's Chromium 103 does not reliably lay it back
                   out when the box returns. The add-on came back blank, still running and
                   still talking to the host, just measured at zero.

                   `visibility:hidden` keeps the box, so the frame keeps its size and never
                   has to be re-laid-out at all. The compositor objection in the note above
                   is about `backdrop-blur`/`transform` layers inside an in-process app
                   leaking over the home screen; an add-on is one replaced element, and a
                   hidden iframe paints nothing. `pointer-events-none` because a hidden box
                   is still a hit-testing target where `display:none` was not. -->
              <div
                class="absolute inset-0"
                class:hidden={!isActive && !isAddOn}
                class:invisible={!isActive && isAddOn}
                class:pointer-events-none={!isActive && isAddOn}
                inert={!isActive}
              >
                {#if manifest && !manifest.core && !AppComponent}
                  <!-- A shipped or Store-installed add-on: source text, a frame, a wall.
                       A `core:false` app that *has* a component is a DEV-only runtime
                       registration (see `registry.ts` and `error_boundary.spec.ts`) and
                       stays on the in-process path below. -->
                  <div class="h-full w-full" inert={isNetworkBlocked}>
                    <AddOnFrame
                      appId={instance.id}
                      {manifest}
                      host={hostForApp(instance.id, manifest)}
                      props={instance.props}
                      active={isActive}
                      onKey={handleFrameKey}
                      onTyping={(t: boolean) => reportTyping(t)}
                    />
                  </div>
                  {#if isNetworkBlocked}
                    <div class="absolute inset-0 z-30">
                      <NotNetworkScreen title={manifest?.name ?? instance.id} onback={goHome} />
                    </div>
                  {/if}
                {:else if AppComponent}
                  <ErrorBoundary appName={manifest?.name ?? instance.id}>
                    <HostProvider host={hostForApp(instance.id, manifest)}>
                      <div class="h-full w-full" inert={isNetworkBlocked}>
                        <AppComponent onback={goHome} {...instance.props} />
                      </div>
                    </HostProvider>
                  </ErrorBoundary>
                  {#if isNetworkBlocked}
                    <div class="absolute inset-0 z-30">
                      <NotNetworkScreen title={manifest?.name ?? instance.id} onback={goHome} />
                    </div>
                  {/if}
                {:else}
                  <!-- The app's chunk is still arriving. Components load on demand now, so
                       there is a moment between opening an app and having its code — and
                       without something here the phone would be blank, with `<Home>` also
                       skipped because the current app is not home. That is the exact
                       failure the `openApp` guard exists to prevent, arriving by a
                       different door. -->
                  <div class="bg-surface flex h-full w-full items-center justify-center">
                    <div
                      class="border-outline-variant border-t-primary h-8 w-8 animate-spin rounded-full border-2"
                    ></div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </PhoneFrame>
      </div>
    </div>
  </main>
{/if}
