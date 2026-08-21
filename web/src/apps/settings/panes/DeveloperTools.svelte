<script lang="ts">
  import {
    useCall,
    useMail,
    useMessages,
    useNavigation,
    usePhoneNotification,
    useSystemHardware,
    useAppAction,
    ToggleSwitch,
    isBrowser
  } from '@gphone/sdk';
  import { useNuiBridge } from '@gphone/sdk/core';

  let { onhide } = $props<{ onhide: () => void }>();

  const { charge, signalLevel, setSignal, soundVolume, soundMuted, setVolume, toggleMute } =
    useSystemHardware();
  const { toast } = usePhoneNotification();
  const { run } = useAppAction('settings');
  const { openApp } = useNavigation();
  const { fetchNui } = useNuiBridge();
  const { callStore } = useCall();
  const { mailStore } = useMail();
  const { conversationsStore } = useMessages();

  // Call Simulation state
  let callName = $state('Ursula (Crazy Ex)');
  let callNumber = $state('555-0199');

  /**
   * Apply a battery level for real rather than only in the UI.
   *
   * The slider used to call `charge.set()`, which the client's drain loop overwrote
   * within a second and which never reached the character's saved charge.
   */
  const applyBatteryLevel = async (level: number) => {
    charge.set(level);
    if (isBrowser()) return;
    await run(() => fetchNui('setBatteryLevel', { level }), {
      error: 'Could not set the battery level'
    });
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
      app: 'settings',
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
    conversationsStore.addReceivedMessage(testMsg);
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

<div class="p-4">
  <h2
    class="text-body-medium mb-2 flex items-center justify-between px-2 tracking-wider text-emerald-400 uppercase"
  >
    <span>Developer Tools</span>
    <span
      class="text-label-small rounded border border-emerald-800 bg-emerald-950 px-1.5 py-0.5 font-mono text-emerald-300"
    >
      Unlocked
    </span>
  </h2>
  <!-- The master switch. On by definition while this pane is reachable; turning it off
       re-locks the group, which is why it is not bound to anything two-way — there is no
       state in which this renders "off". -->
  <div class="bg-surface-container mb-4 overflow-hidden rounded-xl">
    <ToggleSwitch
      label="Developer Tools"
      description="Turn off to hide — 10 taps on OS Version restores"
      checked={true}
      onchange={onhide}
    />
  </div>

  <div class="bg-surface-container text-body-small space-y-4 overflow-hidden rounded-xl p-4">
    <!-- Battery Level -->
    <div class="flex flex-col gap-2">
      <div class="text-on-surface flex items-center justify-between">
        <span class="font-semibold">Battery Charge</span>
        <span class="font-mono text-emerald-400">{Math.round($charge)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={Math.round($charge)}
        oninput={(e) => applyBatteryLevel(Number((e.currentTarget as HTMLInputElement).value))}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-emerald-500"
      />
      <div class="grid grid-cols-4 gap-1.5 pt-0.5">
        <button
          type="button"
          onclick={() => applyBatteryLevel(0)}
          class="text-error text-label-small cursor-pointer rounded border border-red-800 bg-red-950 px-2 py-1.5 text-center hover:bg-red-900"
        >
          0% (Dead)
        </button>
        <button
          type="button"
          onclick={() => applyBatteryLevel(15)}
          class="text-label-small cursor-pointer rounded border border-yellow-800 bg-yellow-950 px-2 py-1.5 text-center text-yellow-300 hover:bg-yellow-900"
        >
          15% (Low)
        </button>
        <button
          type="button"
          onclick={() => applyBatteryLevel(50)}
          class="border-outline bg-surface-container-high text-on-surface hover:bg-surface-container-highest text-label-small cursor-pointer rounded border px-2 py-1.5 text-center"
        >
          50%
        </button>
        <button
          type="button"
          onclick={() => applyBatteryLevel(100)}
          class="text-label-small cursor-pointer rounded border border-emerald-800 bg-emerald-950 px-2 py-1.5 text-center text-emerald-300 hover:bg-emerald-900"
        >
          100%
        </button>
      </div>
    </div>

    <!-- Signal Level -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <div class="text-on-surface flex items-center justify-between">
        <span class="font-semibold">Signal Strength</span>
        <span class="font-mono text-emerald-400">{$signalLevel} Bars</span>
      </div>
      <div class="grid grid-cols-5 gap-1.5">
        {#each [0, 1, 2, 3, 4] as level}
          <button
            type="button"
            onclick={() => setSignal(level)}
            class="text-label-small cursor-pointer rounded border py-1.5 transition-all {$signalLevel ===
            level
              ? 'border-emerald-500 bg-emerald-600 text-white'
              : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high'} duration-short ease-standard"
          >
            {level} Bar{level === 1 ? '' : 's'}
          </button>
        {/each}
      </div>
    </div>

    <!-- System Volume & Sound -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <div class="text-on-surface flex items-center justify-between">
        <span class="font-semibold">System Volume</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={toggleMute}
            class="text-label-small cursor-pointer rounded border px-2 py-0.5 font-mono {$soundMuted
              ? 'text-error border-red-800 bg-red-950'
              : 'border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high'}"
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
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-emerald-500"
      />
    </div>

    <!-- Incoming Call Simulation -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <span class="text-on-surface font-semibold">Incoming Call Test</span>
      <div class="flex gap-2">
        <input
          type="text"
          bind:value={callName}
          placeholder="Caller Name"
          class="border-outline-variant bg-surface text-on-surface placeholder-on-surface-variant w-1/2 rounded border px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
        />
        <input
          type="text"
          bind:value={callNumber}
          placeholder="Phone Number"
          class="border-outline-variant bg-surface text-on-surface placeholder-on-surface-variant w-1/2 rounded border px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
        />
      </div>
      <button
        type="button"
        onclick={triggerCall}
        class="duration-short ease-standard text-body-small w-full cursor-pointer rounded-lg bg-emerald-600 py-2 text-white transition-all hover:bg-emerald-500"
      >
        Simulate Incoming Call
      </button>
    </div>

    <!-- Notification & Message Triggers -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <span class="text-on-surface font-semibold">Push Notifications & SMS</span>
      <div class="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onclick={triggerNotification}
          class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high text-label-small cursor-pointer rounded border px-2 py-1.5 text-center"
        >
          Toast
        </button>
        <button
          type="button"
          onclick={triggerMessage}
          class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high text-label-small cursor-pointer rounded border px-2 py-1.5 text-center"
        >
          SMS
        </button>
        <button
          type="button"
          onclick={triggerMail}
          class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high text-label-small cursor-pointer rounded border px-2 py-1.5 text-center"
        >
          Email
        </button>
      </div>
    </div>
  </div>
</div>
