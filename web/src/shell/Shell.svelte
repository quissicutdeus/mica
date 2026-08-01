<script lang="ts">
  import { onMount } from 'svelte';
  import { appRegistryStore } from './state/registry';
  import { createNuiMessageRouter } from './nuiMessages';
  import { installDevHarness, seedBrowserPhone } from './devHarness';
  import { isBrowser } from '../lib/isBrowser';
  import { currentApp, runningApps, openApp, goHome, closePhone } from './state/navigation';
  import { bindings, dispatchKey, isTypingTarget, registerHandler } from './state/keybinds';
  import { lockDevTools } from './state/devtools';
  import { callStore } from '../services/call';
  import { isPreviewingPhoto } from '../services/camera';
  import PhoneFrame from './PhoneFrame.svelte';
  import Home from './Launcher.svelte';
  import { fetchNui } from '../nui/fetchNui';
  import { toast } from './state/toast';
  import { bootstrapStores } from './state/bootstrap';
  import ToastContainer from './ToastHost.svelte';
  import ErrorBoundary from './ErrorBoundary.svelte';

  let visible = $state(isBrowser());

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
      if (!visible && isFreelook) isFreelook = false;
      // Developer Tools are earned per session, so closing the phone puts them back
      // behind the ten taps.
      if (!visible) lockDevTools();
      return;
    }

    if (action === 'callStatus') {
      // { status: 'connected' | 'idle' | 'incoming', number: '...', name: '...' }
      if (data.status === 'incoming') {
        callStore.setIncoming(data.number, data.name);
        incomingToastId = toast.showCall({
          name: data.name,
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

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      // Held keys must not repeat-fire an action; the old Alt branch special-cased this
      // and nothing else did.
      if (event.repeat) return;

      /**
       * Browser only: honour the Open Phone binding here.
       *
       * That action is `scope: 'game'`, so in game it is a `RegisterKeyMapping` the
       * client owns and the web never sees it. There is no FiveM in a browser, so
       * nothing was listening at all and a collapsed phone could only be reopened with
       * the mouse.
       *
       * Checked before `dispatchKey` because a collapsed phone has no meaningful
       * phone-scope action, and after the typing guard so it cannot fire out from under
       * a focused field.
       */
      if (isBrowser() && !isTypingTarget(event.target)) {
        const openKey = $bindings.openPhone;
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

    seedBrowserPhone(new Date());
    installDevHarness();

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
    };
  });

  $effect(() => {
    if (visible) {
      bootstrapStores();
    }
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
    class="fixed right-4 bottom-4 z-[9999] flex cursor-pointer items-center gap-2 rounded-full border border-gray-700 bg-gray-900/90 px-4 py-2 text-xs font-medium text-white shadow-2xl backdrop-blur-md transition-all hover:bg-gray-800"
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
  <main
    class="flex h-screen w-screen overflow-hidden p-12"
    class:items-center={$currentApp.id === 'camera'}
    class:justify-center={$currentApp.id === 'camera'}
    class:items-end={$currentApp.id !== 'camera'}
    class:justify-end={$currentApp.id !== 'camera'}
    class:bg-transparent={true}
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
           why tests here use role-based locators. -->
      <div class="relative h-full w-full">
        {#if $currentApp.id === 'home'}
          <Home {openApp} />
        {/if}

        {#each $runningApps as instance (instance.id)}
          {@const AppComponent = appRegistryStore.getComponent(instance.id)}
          {#if AppComponent}
            {@const isActive = $currentApp.id === instance.id}
            <div
              class="absolute inset-0"
              class:hidden={!isActive}
              aria-hidden={!isActive}
              inert={!isActive}
            >
              <ErrorBoundary
                appName={appRegistryStore.getManifest(instance.id)?.name ?? instance.id}
              >
                <AppComponent onback={goHome} {...instance.props} />
              </ErrorBoundary>
            </div>
          {/if}
        {/each}
      </div>
    </PhoneFrame>
  </main>
{/if}
