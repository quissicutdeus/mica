<script lang="ts">
  import { onMount } from 'svelte';
  import { hydrateSettings } from '../sdk/host/useStorage';
  import { migrateAppDrawerHintForExistingSaves } from './state/onboarding';
  import { appRegistryStore } from './state/registry';
  import { createNuiMessageRouter } from './nuiMessages';
  import { installDevHarness, seedBrowserPhone } from './devHarness';
  import { isBrowser } from '../lib/isBrowser';
  import { currentApp, runningApps, openApp, goHome, closePhone } from './state/navigation';
  import { dispatchKey, isTypingTarget, registerHandler } from './state/keybinds';
  import { findAction } from '@shared/keybinds';
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
  import { contacts } from '../services/contacts';
  import { isPreviewingPhoto } from '../services/camera';
  import PhoneFrame from './PhoneFrame.svelte';
  import Home from './Launcher.svelte';
  import Dock from './Dock.svelte';
  import AppDrawer from './AppDrawer.svelte';
  import Search from './Search.svelte';
  import { fetchNui } from '../nui/fetchNui';
  import { toast } from './state/toast';
  import { bootstrapStores } from './state/bootstrap';
  import ToastContainer from './ToastHost.svelte';
  import ErrorBoundary from './ErrorBoundary.svelte';
  import NotNetworkScreen from './NotNetworkScreen.svelte';
  import AppCapabilityProvider from '../sdk/AppCapabilityProvider.svelte';
  import { clampedSignalLevel } from './state/signal';
  import { audio } from './state/audio';
  import { isLightMode } from './state/theme';

  let visible = $state(isBrowser());

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
    const { action, data } = event.data ?? {};

    if (action === 'setVisible') {
      visible = data;
      if (visible) audio.warm();
      if (!visible && isFreelook) isFreelook = false;
      // Developer Tools are earned per session, so closing the phone puts them back
      // behind the ten taps.
      if (!visible) lockDevTools();
      return;
    }

    if (action === 'callStatus') {
      // { status: 'connected' | 'idle' | 'incoming', number: '...', name: '...' }
      if (data.status === 'incoming') {
        // The client has no address book to check — that lives in the web layer's own
        // contacts store — so it sends 'Unknown' and this is the one place that can
        // still resolve a name from the caller's number before the toast renders.
        const known = get(contacts).find((c) => c.phone === data.number);
        const displayName = known ? `${known.firstname} ${known.lastname || ''}`.trim() : data.name;
        callStore.setIncoming(data.number, displayName);
        incomingToastId = toast.showCall({
          name: displayName,
          number: data.number,
          onAccept: () => {
            visible = true;
            openApp('phone');
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
        callStore.setStatus(data.status);
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

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
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
      if (isBrowser() && !isTypingTarget(event.target)) {
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

      dispatchKey(event, {
        currentApp: $currentApp.id,
        callStatus: $callStore.status
      });
    };

    /**
     * Tell the client when a text field has focus.
     *
     * The client cannot see DOM focus, and `RegisterKeyMapping` bindings would otherwise
     * still fire while typing — reachable today via freelook, which enables
     * `SetNuiFocusKeepInput`. Typing `MM` into a message would insert two characters and
     * toggle the phone twice.
     */
    const reportTyping = (typing: boolean) => fetchNui('setTyping', { typing }).catch(() => {});
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

    // Sized from a measured viewport rather than `100vh` — see `state/display.ts` for why
    // that unit is wrong in a mobile browser and why `dvh` is not available to us.
    const stopObservingViewport = observeViewport();

    seedBrowserPhone(new Date());
    installDevHarness();

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
      stopObservingViewport();
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

{#if !visible && isBrowser()}
  <button
    onclick={() => (visible = true)}
    class="shadow-elevation-5 duration-short ease-standard text-body-small fixed right-4 bottom-4 z-[9999] flex cursor-pointer items-center gap-2 rounded-full border border-gray-700 bg-gray-900/90 px-4 py-2 text-white backdrop-blur-md transition-all hover:bg-gray-800"
  >
    <span class="relative flex h-2 w-2">
      <span
        class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
      ></span>
      <span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
    </span>
    Open gPhone
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
              <Search {openApp} />
              <AppDrawer {openApp} />
            {/if}

            {#each $runningApps as instance (instance.id)}
              {@const AppComponent = appRegistryStore.getComponent(instance.id)}
              {@const isActive = $currentApp.id === instance.id}
              {@const manifest = appRegistryStore.getManifest(instance.id)}
              {@const isNetworkBlocked =
                (manifest?.requiresNetwork ?? false) && $clampedSignalLevel === 0}
              <div class="absolute inset-0" class:hidden={!isActive} inert={!isActive}>
                {#if AppComponent}
                  <ErrorBoundary appName={manifest?.name ?? instance.id}>
                    <AppCapabilityProvider appId={instance.id} {manifest}>
                      <div class="h-full w-full" inert={isNetworkBlocked}>
                        <AppComponent onback={goHome} {...instance.props} />
                      </div>
                    </AppCapabilityProvider>
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
