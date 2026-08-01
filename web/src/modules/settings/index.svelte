<script lang="ts">
  import { onMount } from 'svelte';
  import Screen from '../../components/Screen.svelte';
  import {
    MICA_BUILD_INFO,
    useSystemHardware,
    usePhoneNotification,
    useNavigation,
    useNuiBridge,
    useAccount,
    useAppRegistry,
    useStorage,
    useCall,
    useMail,
    useMessages
  } from '@gphone/sdk';
  import { formatDate } from '../../utils/formatters';
  import { isBrowser } from '../../utils/isBrowser';

  const { myPhoneNumber, fetchPhoneNumber } = useAccount();
  const { getFirstBootTime } = useAppRegistry();
  const { callStore } = useCall();
  const { mailStore } = useMail();
  const { messagesStore } = useMessages();

  let { onback } = $props<{ onback?: () => void }>();

  const {
    charge,
    signalLevel,
    setSignal,
    soundVolume,
    soundMuted,
    setVolume,
    toggleMute,
    is24Hour
  } = useSystemHardware();

  const { toast } = usePhoneNotification();
  const { openApp } = useNavigation();
  const { fetchNui } = useNuiBridge();

  // Call Simulation state
  let callName = $state('Ursula (Crazy Ex)');
  let callNumber = $state('555-0199');

  /**
   * Copy the player's number so it can be pasted into a message.
   *
   * `navigator.clipboard` needs a secure context. NUI is served over
   * `https://cfx-nui-<resource>/` so it qualifies, but CEF can still refuse the
   * permission — hence the execCommand fallback, which is deprecated on the open web
   * and entirely reliable here.
   */
  const copyPhoneNumber = async () => {
    const number = $myPhoneNumber;
    let copied = false;

    try {
      await navigator.clipboard.writeText(number);
      copied = true;
    } catch {
      try {
        const scratch = document.createElement('textarea');
        scratch.value = number;
        // Keep it off-screen and unfocusable so the phone UI does not visibly shift.
        scratch.setAttribute('readonly', '');
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        scratch.style.pointerEvents = 'none';
        document.body.appendChild(scratch);
        scratch.select();
        copied = document.execCommand('copy');
        document.body.removeChild(scratch);
      } catch {
        copied = false;
      }
    }

    toast.show(
      copied
        ? { type: 'success', message: `Copied ${number} to clipboard` }
        : { type: 'error', message: 'Could not copy your number' }
    );
  };

  /**
   * Ten taps on the build row reveals Developer Tools, the way Android reveals its
   * developer options. In a browser the panel is always available, so this only
   * matters in game.
   */
  const devToolsStore = useStorage('settings');
  const DEV_TOOLS_KEY = 'devToolsUnlocked';

  let devToolsTaps = $state(0);
  // Persisted: switching apps destroys this component (App.svelte re-keys on
  // currentApp.name), so component state alone would drop the unlock immediately.
  let devToolsUnlocked = $state(devToolsStore.getItem<boolean>(DEV_TOOLS_KEY, false) === true);
  let tapResetTimer: ReturnType<typeof setTimeout> | undefined;

  const TAPS_TO_UNLOCK = 10;

  const tapBuildRow = () => {
    if (devToolsUnlocked) return;

    devToolsTaps += 1;
    clearTimeout(tapResetTimer);
    // Taps must be consecutive; drifting off resets the count.
    tapResetTimer = setTimeout(() => (devToolsTaps = 0), 2000);

    const remaining = TAPS_TO_UNLOCK - devToolsTaps;

    if (remaining <= 0) {
      devToolsUnlocked = true;
      devToolsStore.setItem(DEV_TOOLS_KEY, true);
      devToolsTaps = 0;
      clearTimeout(tapResetTimer);
      toast.show({ type: 'success', message: 'Developer Tools unlocked' });
    } else if (remaining <= 3) {
      toast.show({ type: 'info', message: `${remaining} more to unlock Developer Tools` });
    }
  };

  /** Browser always shows the panel; in game it has to be earned, then stays. */
  const showDevTools = $derived(isBrowser() || devToolsUnlocked);

  const hideDevTools = () => {
    devToolsUnlocked = false;
    devToolsStore.setItem(DEV_TOOLS_KEY, false);
    devToolsTaps = 0;
    toast.show({ type: 'info', message: 'Developer Tools hidden — tap OS Version 10x to restore' });
  };

  /**
   * Apply a battery level for real rather than only in the UI.
   *
   * The slider used to call `charge.set()`, which the client's drain loop overwrote
   * within a second and which never reached the character's saved charge.
   */
  const applyBatteryLevel = async (level: number) => {
    charge.set(level);
    if (isBrowser()) return;
    try {
      await fetchNui('setBatteryLevel', { level });
    } catch (e) {
      console.error('Failed to apply battery level', e);
    }
  };

  onMount(() => {
    fetchPhoneNumber();
  });

  const toggleTimeFormat = () => {
    is24Hour.update((v) => !v);
  };

  const triggerCall = () => {
    callStore.setIncoming(callNumber, callName);
    toast.showCall({
      name: callName,
      number: callNumber,
      onAccept: () => {
        openApp('phone');
      },
      onDecline: () => {
        callStore.setStatus('idle');
        fetchNui('rejectCall', { number: callNumber });
      }
    });
  };

  const triggerNotification = () => {
    toast.show({
      type: 'info',
      title: 'Simulated Toast',
      message: 'This is a test push notification from Developer Tools.'
    });
  };

  const triggerMessage = () => {
    const testMsg = {
      conversation_id: 1,
      senderName: 'Ursula (Crazy Ex)',
      message: 'Hey! This is a test SMS from Developer Tools.',
      phone: '555-0199',
      avatar:
        'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80'
    };
    messagesStore.addReceivedMessage(testMsg);
    toast.showIncomingMessage({
      sender: testMsg.senderName,
      message: testMsg.message,
      avatar: testMsg.avatar,
      onReply: async () => {},
      onClick: () => {
        openApp('messages', {
          conversationId: testMsg.conversation_id,
          phone: testMsg.phone
        });
      }
    });
  };

  const triggerMail = () => {
    const nowStr = new Date().toISOString();
    const testMail = {
      id: Date.now(),
      citizenid: 'DEV12345',
      sender: 'boss@ls-gov.org',
      subject: 'Quarterly Review Notice',
      content: 'Please review your upcoming schedule and metrics.',
      read: false,
      status: 'active' as const,
      created_at: nowStr,
      updated_at: nowStr
    };
    mailStore.addReceivedMail(testMail);
    toast.showMail({
      sender: testMail.sender,
      subject: testMail.subject,
      onClick: () => {
        openApp('mail', { mailId: testMail.id });
      }
    });
  };
</script>

<Screen title="Settings" {onback}>
  <div class="space-y-6 p-4">
    <!-- General Section -->
    <div>
      <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">General</h2>
      <div class="overflow-hidden rounded-xl bg-gray-800">
        <button
          type="button"
          onclick={toggleTimeFormat}
          class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700"
          aria-label="Toggle 24-hour time"
        >
          <div class="flex flex-col">
            <span class="font-medium">24-Hour Time</span>
            <span class="text-sm text-gray-400">Use 24-hour format</span>
          </div>
          <div
            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none"
            class:bg-blue-600={$is24Hour}
            class:bg-gray-600={!$is24Hour}
          >
            <span
              class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
              class:translate-x-6={$is24Hour}
              class:translate-x-1={!$is24Hour}
            ></span>
          </div>
        </button>
      </div>
    </div>

    <!-- About Section -->
    <div>
      <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">About</h2>
      <div class="divide-y divide-gray-700 overflow-hidden rounded-xl bg-gray-800 text-sm">
        <button
          type="button"
          onclick={copyPhoneNumber}
          class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
          aria-label="Copy phone number to clipboard"
        >
          <span class="font-medium text-gray-300">Phone Number</span>
          <span class="font-mono text-gray-200">{$myPhoneNumber}</span>
        </button>
        <div class="flex items-center justify-between p-4">
          <span class="font-medium text-gray-300">First Boot</span>
          <span class="font-mono text-xs text-gray-300">{formatDate(getFirstBootTime())}</span>
        </div>
        <div class="flex items-center justify-between p-4">
          <span class="font-medium text-gray-300">Software</span>
          <span class="font-semibold text-white">gPhone</span>
        </div>
        <!-- OS Version carries the build info: `v1.0.0 (branch@commit)`. Was a separate
             "Build / Commit" row saying almost the same thing. Ten taps here reveal
             Developer Tools in game. -->
        <button
          type="button"
          onclick={tapBuildRow}
          class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
        >
          <span class="font-medium text-gray-300">OS Version</span>
          <span class="font-mono text-indigo-400">{MICA_BUILD_INFO}</span>
        </button>
      </div>
    </div>

    <!-- Developer Tools Section (browser always; in game after 10 taps on OS Version) -->
    {#if showDevTools}
      <div>
        <h2
          class="mb-2 flex items-center justify-between px-2 text-sm font-medium tracking-wider text-emerald-400 uppercase"
        >
          <span>Developer Tools</span>
          <span
            class="rounded border border-emerald-800 bg-emerald-950 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
          >
            {isBrowser() ? 'Browser' : 'Unlocked'}
          </span>
        </h2>
        <div class="space-y-4 overflow-hidden rounded-xl bg-gray-800 p-4 text-xs">
          <!-- Hide toggle. In a browser the panel is unconditional, so there is nothing
               to hide; in game it is the way back out without hunting for the tap row. -->
          {#if !isBrowser()}
            <button
              type="button"
              onclick={hideDevTools}
              class="flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-left transition-colors hover:border-gray-600 hover:bg-gray-900"
            >
              <span class="font-semibold text-gray-300">Hide Developer Tools</span>
              <span class="font-mono text-[10px] text-gray-500">10 taps to restore</span>
            </button>
          {/if}

          <!-- Battery Level -->
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between text-gray-300">
              <span class="font-semibold">Battery Charge</span>
              <span class="font-mono text-emerald-400">{Math.round($charge)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round($charge)}
              oninput={(e) =>
                applyBatteryLevel(Number((e.currentTarget as HTMLInputElement).value))}
              class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-gray-900 accent-emerald-500"
            />
            <div class="grid grid-cols-4 gap-1.5 pt-0.5">
              <button
                type="button"
                onclick={() => applyBatteryLevel(0)}
                class="cursor-pointer rounded border border-red-800 bg-red-950 px-2 py-1.5 text-center text-[10px] font-semibold text-red-300 hover:bg-red-900"
              >
                0% (Dead)
              </button>
              <button
                type="button"
                onclick={() => applyBatteryLevel(15)}
                class="cursor-pointer rounded border border-yellow-800 bg-yellow-950 px-2 py-1.5 text-center text-[10px] font-semibold text-yellow-300 hover:bg-yellow-900"
              >
                15% (Low)
              </button>
              <button
                type="button"
                onclick={() => applyBatteryLevel(50)}
                class="cursor-pointer rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-center text-[10px] font-semibold text-gray-200 hover:bg-gray-600"
              >
                50%
              </button>
              <button
                type="button"
                onclick={() => applyBatteryLevel(100)}
                class="cursor-pointer rounded border border-emerald-800 bg-emerald-950 px-2 py-1.5 text-center text-[10px] font-semibold text-emerald-300 hover:bg-emerald-900"
              >
                100%
              </button>
            </div>
          </div>

          <!-- Signal Level -->
          <div class="flex flex-col gap-2 border-t border-gray-700 pt-3">
            <div class="flex items-center justify-between text-gray-300">
              <span class="font-semibold">Signal Strength</span>
              <span class="font-mono text-emerald-400">{$signalLevel} Bars</span>
            </div>
            <div class="grid grid-cols-5 gap-1.5">
              {#each [0, 1, 2, 3, 4] as level}
                <button
                  type="button"
                  onclick={() => setSignal(level)}
                  class="cursor-pointer rounded border py-1.5 text-[11px] font-semibold transition-all {$signalLevel ===
                  level
                    ? 'border-emerald-500 bg-emerald-600 text-white'
                    : 'border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-700'}"
                >
                  {level} Bar{level === 1 ? '' : 's'}
                </button>
              {/each}
            </div>
          </div>

          <!-- System Volume & Sound -->
          <div class="flex flex-col gap-2 border-t border-gray-700 pt-3">
            <div class="flex items-center justify-between text-gray-300">
              <span class="font-semibold">System Volume</span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  onclick={toggleMute}
                  class="cursor-pointer rounded border px-2 py-0.5 font-mono text-[10px] {$soundMuted
                    ? 'border-red-800 bg-red-950 text-red-400'
                    : 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-700'}"
                >
                  {$soundMuted ? 'MUTED' : 'UNMUTED'}
                </button>
                <span class="font-mono text-emerald-400">{Math.round($soundVolume * 100)}%</span>
              </div>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={$soundVolume}
              oninput={(e) => setVolume(Number((e.currentTarget as HTMLInputElement).value))}
              class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-gray-900 accent-emerald-500"
            />
          </div>

          <!-- Incoming Call Simulation -->
          <div class="flex flex-col gap-2 border-t border-gray-700 pt-3">
            <span class="font-semibold text-gray-300">Incoming Call Test</span>
            <div class="flex gap-2">
              <input
                type="text"
                bind:value={callName}
                placeholder="Caller Name"
                class="w-1/2 rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-gray-200 placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
              />
              <input
                type="text"
                bind:value={callNumber}
                placeholder="Phone Number"
                class="w-1/2 rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-gray-200 placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onclick={triggerCall}
              class="w-full cursor-pointer rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white transition-all hover:bg-emerald-500"
            >
              Simulate Incoming Call
            </button>
          </div>

          <!-- Notification & Message Triggers -->
          <div class="flex flex-col gap-2 border-t border-gray-700 pt-3">
            <span class="font-semibold text-gray-300">Push Notifications & SMS</span>
            <div class="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onclick={triggerNotification}
                class="cursor-pointer rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-center text-[11px] font-medium text-gray-200 hover:bg-gray-700"
              >
                Toast
              </button>
              <button
                type="button"
                onclick={triggerMessage}
                class="cursor-pointer rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-center text-[11px] font-medium text-gray-200 hover:bg-gray-700"
              >
                SMS
              </button>
              <button
                type="button"
                onclick={triggerMail}
                class="cursor-pointer rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-center text-[11px] font-medium text-gray-200 hover:bg-gray-700"
              >
                Email
              </button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</Screen>
