<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    useCall,
    useLocale,
    useMail,
    useMessages,
    useNavigation,
    usePhoneNotification,
    useSystemHardware,
    useSystemHardwareWrite,
    useAppAction,
    ToggleSwitch,
    isBrowser,
    placeholderAvatar
  } from '@gos/sdk';
  import { useNuiBridge } from '@gos/sdk/core';

  let { onhide } = $props<{ onhide: () => void }>();

  const { t, plural } = useLocale();
  const { charge, signalLevel, soundVolume, soundMuted } = useSystemHardware();
  const { setCharge, setSignal, setVolume, toggleMute } = useSystemHardwareWrite();
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
    setCharge(level);
    if (isBrowser()) return;
    await run(() => fetchNui('setBatteryLevel', { level }), {
      error: $t('settings.devtools.batteryError')
    });
  };

  /**
   * In a browser there is no server to ask, so this fakes the toast locally — always
   * has. In game it used to do the exact same thing: a toast with no call behind it,
   * where Accept opened the Phone app onto a call that didn't exist and Decline told
   * the server to end one it had never started. Now it drives the real call machinery
   * instead — `gos:server:phone:simulateIncoming`, the NUI-reachable twin of the
   * `goscall` console command — and Shell.svelte's own `callStatus` handler takes it
   * from there, the same as any real incoming call. The display name won't be
   * `callName` unless it happens to match a saved contact; that's what a real call
   * does too.
   */
  const triggerCall = () => {
    if (isBrowser()) {
      callStore.setIncoming(callNumber, callName);
      // Held so Accept can archive it. The simulation mirrors the real ring in
      // `Shell.svelte` — including clearing the shade row on pickup — because a test path
      // that behaves differently from the thing it stands in for is worse than no test path.
      let simulatedToastId: string | null = null;
      simulatedToastId = toast.showCall({
        name: callName,
        number: callNumber,
        onAccept: () => {
          openApp('phone');
          callStore.setStatus('connected');
          if (simulatedToastId) {
            void toast.archive(simulatedToastId);
            simulatedToastId = null;
          }
        },
        onDecline: () => {
          callStore.setStatus('idle');
          fetchNui('rejectCall', { number: callNumber });
        }
      });
      return;
    }
    void run(() => fetchNui('simulateIncomingCall', { number: callNumber }), {
      error: $t('settings.devtools.callError')
    });
  };

  const triggerNotification = () => {
    toast.show({
      type: 'info',
      app: 'settings',
      title: $t('settings.devtools.simulatedToastTitle'),
      message: $t('settings.devtools.simulatedToastMessage')
    });
  };

  const triggerMessage = () => {
    const testMsg = {
      conversation_id: 1,
      senderName: 'Ursula (Crazy Ex)',
      message: $t('settings.devtools.testSmsMessage'),
      phone: '555-0199',
      avatar: placeholderAvatar('Ursula')
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
      subject: $t('settings.devtools.testMailSubject'),
      content: $t('settings.devtools.testMailContent'),
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
    <span>{$t('settings.devtools.title')}</span>
    <span
      class="text-label-small rounded-chip border border-emerald-800 bg-emerald-950 px-1.5 py-0.5 font-mono text-emerald-300"
    >
      {$t('settings.devtools.unlockedBadge')}
    </span>
  </h2>
  <!-- The master switch. On by definition while this pane is reachable; turning it off
       re-locks the group, which is why it is not bound to anything two-way — there is no
       state in which this renders "off". -->
  <div class="bg-surface-container mb-4 overflow-hidden rounded-box">
    <ToggleSwitch
      label={$t('settings.devtools.title')}
      description={$t('settings.devtools.toggleDescription')}
      checked={true}
      onchange={onhide}
    />
  </div>

  <div class="bg-surface-container text-body-small space-y-4 overflow-hidden rounded-box p-4">
    <!-- Battery Level -->
    <div class="flex flex-col gap-2">
      <div class="text-on-surface flex items-center justify-between">
        <span class="font-semibold">{$t('settings.devtools.batteryCharge')}</span>
        <span class="font-mono text-emerald-400">{Math.round($charge)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={Math.round($charge)}
        oninput={(e) => applyBatteryLevel(Number(e.currentTarget.value))}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-box accent-emerald-500"
      />
      <div class="grid grid-cols-4 gap-1.5 pt-0.5">
        <button
          type="button"
          onclick={() => applyBatteryLevel(0)}
          class="text-error text-label-small cursor-pointer rounded-chip border border-red-800 bg-red-950 px-2 py-1.5 text-center hover:bg-red-900"
        >
          {$t('settings.devtools.batteryDead')}
        </button>
        <button
          type="button"
          onclick={() => applyBatteryLevel(15)}
          class="text-label-small cursor-pointer rounded-chip border border-yellow-800 bg-yellow-950 px-2 py-1.5 text-center text-yellow-300 hover:bg-yellow-900"
        >
          {$t('settings.devtools.batteryLow')}
        </button>
        <button
          type="button"
          onclick={() => applyBatteryLevel(50)}
          class="border-outline bg-surface-container-high text-on-surface hover:bg-surface-container-highest text-label-small cursor-pointer rounded-chip border px-2 py-1.5 text-center"
        >
          50%
        </button>
        <button
          type="button"
          onclick={() => applyBatteryLevel(100)}
          class="text-label-small cursor-pointer rounded-chip border border-emerald-800 bg-emerald-950 px-2 py-1.5 text-center text-emerald-300 hover:bg-emerald-900"
        >
          100%
        </button>
      </div>
    </div>

    <!-- Signal Level -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <div class="text-on-surface flex items-center justify-between">
        <span class="font-semibold">{$t('settings.devtools.signalStrength')}</span>
        <span class="font-mono text-emerald-400"
          >{$t('settings.devtools.signalBars', { count: $signalLevel })}</span
        >
      </div>
      <div class="grid grid-cols-5 gap-1.5">
        {#each [0, 1, 2, 3, 4] as level (level)}
          <button
            type="button"
            onclick={() => setSignal(level)}
            class="text-label-small cursor-pointer rounded-chip border py-1.5 transition-all {$signalLevel ===
            level
              ? 'border-emerald-500 bg-emerald-600 text-white'
              : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high'} duration-short ease-standard"
          >
            {plural('settings.devtools.bars', level)}
          </button>
        {/each}
      </div>
    </div>

    <!-- System Volume & Sound -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <div class="text-on-surface flex items-center justify-between">
        <span class="font-semibold">{$t('settings.devtools.systemVolume')}</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={toggleMute}
            class="text-label-small cursor-pointer rounded-chip border px-2 py-0.5 font-mono {$soundMuted
              ? 'text-error border-red-800 bg-red-950'
              : 'border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high'}"
          >
            {$soundMuted ? $t('settings.devtools.muted') : $t('settings.devtools.unmuted')}
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
        oninput={(e) => setVolume(Number(e.currentTarget.value))}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-box accent-emerald-500"
      />
    </div>

    <!-- Incoming Call Simulation -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <span class="text-on-surface font-semibold">{$t('settings.devtools.callTest')}</span>
      <span class="text-on-surface-variant text-label-small">
        {isBrowser()
          ? $t('settings.devtools.callTestBrowser')
          : $t('settings.devtools.callTestGame')}
      </span>
      <div class="flex gap-2">
        <input
          type="text"
          bind:value={callName}
          placeholder={$t('settings.devtools.callerName')}
          class="border-outline-variant bg-surface text-on-surface placeholder-on-surface-variant w-1/2 rounded-chip border px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
        />
        <input
          type="text"
          bind:value={callNumber}
          placeholder={$t('settings.devtools.phoneNumber')}
          class="border-outline-variant bg-surface text-on-surface placeholder-on-surface-variant w-1/2 rounded-chip border px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
        />
      </div>
      <button
        type="button"
        onclick={triggerCall}
        class="duration-short ease-standard text-body-small w-full cursor-pointer rounded-box bg-emerald-600 py-2 text-white transition-all hover:bg-emerald-500"
      >
        {$t('settings.devtools.simulateCall')}
      </button>
    </div>

    <!-- Notification & Message Triggers -->
    <div class="border-outline-variant flex flex-col gap-2 border-t pt-3">
      <span class="text-on-surface font-semibold">{$t('settings.devtools.pushSection')}</span>
      <div class="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onclick={triggerNotification}
          class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high text-label-small cursor-pointer rounded-chip border px-2 py-1.5 text-center"
        >
          {$t('settings.devtools.toastButton')}
        </button>
        <button
          type="button"
          onclick={triggerMessage}
          class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high text-label-small cursor-pointer rounded-chip border px-2 py-1.5 text-center"
        >
          {$t('settings.devtools.smsButton')}
        </button>
        <button
          type="button"
          onclick={triggerMail}
          class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high text-label-small cursor-pointer rounded-chip border px-2 py-1.5 text-center"
        >
          {$t('settings.devtools.emailButton')}
        </button>
      </div>
    </div>
  </div>
</div>
