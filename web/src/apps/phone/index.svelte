<script lang="ts">
  import {
    onAppForeground,
    useCall,
    useContacts,
    Avatar,
    Screen,
    SegmentedControl,
    BackspaceIcon,
    KeypadIcon,
    MicrophoneIcon,
    PhoneIcon,
    SpeakerIcon,
    ArrowUpRightIcon,
    ArrowDownLeftIcon,
    type AppProps
  } from '@gphone/sdk';

  const { callStore, callLog, loadCallLog } = useCall();
  const { contactsStore, favoriteContacts } = useContacts();

  let { onback }: AppProps = $props();

  let activeTab = $state<'keypad' | 'recents'>('keypad');

  let enteredNumber = $state('');
  /** The DTMF pad shown over an active call. Local only. */
  let showInCallKeypad = $state(false);
  let dtmfEntered = $state('');

  const handleKeypad = (num: string) => {
    if (enteredNumber.length < 15) {
      enteredNumber += num;
    }
  };

  const handleBackspace = () => {
    enteredNumber = enteredNumber.slice(0, -1);
  };

  const startCall = (number: string, name?: string) => {
    if (!number) return;
    callStore.startCall(number, name);
  };

  /**
   * The status this effect last saw. A plain `let`, deliberately not `$state`: it is a
   * latch for the effect below, and making it reactive would re-run the effect on its own
   * write.
   */
  let previousCallStatus: string = 'idle';

  $effect(() => {
    const status = $callStore.status;
    if (status === 'idle') {
      showInCallKeypad = false;
      dtmfEntered = '';
      // Recents is written when a call *ends*, and every way it can end lands here: the
      // hang-up button below, the peer hanging up first, a decline, and a number that was
      // never reachable — the last three arrive as a `callStatus: idle` push and used to
      // refresh nothing at all, so the row the server had just written stayed invisible
      // until the app was backgrounded and reopened (MICA-95). Guarded on the
      // *transition* out of a call, so a plain mount — already idle — does not refetch
      // what `onAppForeground` loaded a moment ago.
      if (previousCallStatus !== 'idle') void loadCallLog();
    }
    previousCallStatus = status;
  });

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const nameForNumber = (number: string): string => {
    const match = $contactsStore.find((c) => c.phone === number);
    if (!match) return number;
    return match.lastname ? `${match.firstname} ${match.lastname}` : match.firstname;
  };

  const formatCallTimestamp = (raw: Date | string) => {
    try {
      const date = new Date(raw);
      if (isNaN(date.getTime())) return '';
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}d ago`;
    } catch {
      return '';
    }
  };

  // Ensure contacts and the call log are current on every visit, not just once.
  onAppForeground('phone', () => {
    void contactsStore.load();
    void loadCallLog();
  });
</script>

<div class="bg-surface text-on-surface relative flex h-full flex-col overflow-hidden">
  {#if $callStore.status === 'idle'}
    <!-- Keypad / Recents -->
    <Screen title="Phone" {onback}>
      <!-- `Screen`'s content box is `flex-1 overflow-y-auto` and *not* a flex column, so a
           child asking for `h-full` got the full height of that box rather than what was
           left under the tabs — tabs plus a full screen overflowed it, and the whole app
           scrolled. This column is the missing layer: it fills the content box exactly, the
           tabs take their natural height, and the pane below takes the rest. -->
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="px-4 pt-2">
          <SegmentedControl
            options={[
              { id: 'keypad', label: 'Keypad' },
              { id: 'recents', label: 'Recents' }
            ]}
            bind:selected={activeTab}
            aria-label="Phone view"
          />
        </div>

        {#if activeTab === 'keypad'}
          <!-- `justify-end` used to bottom-cram this whole column, with the favourites bar's
             own `mb-auto` acting as the only thing holding the top. A player with no
             favourites — which is everyone until they mark one — got no such spacer, so the
             keypad collapsed against the bottom edge and the entire upper half of the app
             was dead space. The dialler group below carries its own `flex-1` centring
             instead, so it sits properly whether or not the bar above it exists.

             `pb-14` rather than `pb-12`: the call button was landing on top of the frame's
             own home-indicator pill (`h-6` at `bottom-0` in `PhoneFrame.svelte`).

             `pt-4` rather than `pt-8`, and the favourites block below carries no `mt-4`
             any more: the two stacked into a 48px drop from the segmented control to the
             FAVORITES label, six times every other gap in the section and reading as a
             stray margin rather than a section break (MICA-93). -->
          <div class="flex min-h-0 flex-1 flex-col items-center px-8 pt-4 pb-14">
            <!-- Favorites Bar -->
            {#if $favoriteContacts.length > 0}
              <div class="w-full">
                <div class="text-on-surface-variant text-body-small mb-2 ml-1 uppercase">
                  Favorites
                </div>
                <div class="no-scrollbar flex space-x-4 overflow-x-auto pb-2">
                  {#each $favoriteContacts as fav (fav.id)}
                    <button
                      class="flex min-w-[64px] flex-col items-center space-y-1"
                      onclick={() => startCall(fav.phone, `${fav.firstname} ${fav.lastname || ''}`)}
                    >
                      <Avatar
                        initials={(fav.firstname[0] || '') + (fav.lastname?.[0] || '')}
                        size="w-12 h-12"
                        textClass="text-lg"
                        bgClass="bg-yellow-600 shadow-elevation-3"
                      />
                      <span class="text-on-surface text-body-small w-full truncate text-center"
                        >{fav.firstname}</span
                      >
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- One `gap-6` for the whole dialler rather than a `mb-8` here and an `mt-8`
                 there. The number display used to own a hard 32px below it and nothing at
                 all above it — the only thing separating it from the favourites bar was
                 that bar's own `pb-2` — so it read as the last row of Favorites instead of
                 its own element between Favorites and the keypad (MICA-92). A single gap
                 makes the two sides of it equal by construction. -->
            <div class="flex w-full flex-1 flex-col items-center justify-center gap-6">
              <!-- Number Display -->
              <div class="flex h-12 items-center text-4xl font-light">
                {enteredNumber}
              </div>

              <!-- Keypad.

                   `justify-self-center` on every key, the same way the in-call DTMF pad
                   below does it. The columns are `1fr` and the keys are a fixed `w-16`, so
                   without it each key sat at the *start* of a column 13px wider than
                   itself: the grid's painted content ended ~7px short on the right and the
                   whole pad hung left of the call button and number display, which are
                   both centred on the screen axis (MICA-94). -->
              <div class="grid w-full max-w-[280px] grid-cols-3 gap-6">
                {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as num (num)}
                  <button
                    class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center justify-self-center rounded-full text-2xl font-medium transition-colors"
                    onclick={() => handleKeypad(num.toString())}
                  >
                    {num}
                  </button>
                {/each}
                <button
                  class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center justify-self-center rounded-full text-2xl font-medium transition-colors"
                  onclick={() => handleKeypad('*')}>*</button
                >
                <button
                  class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center justify-self-center rounded-full text-2xl font-medium transition-colors"
                  onclick={() => handleKeypad('0')}>0</button
                >
                <button
                  class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center justify-self-center rounded-full text-2xl font-medium transition-colors"
                  onclick={() => handleKeypad('#')}>#</button
                >
              </div>

              <div class="relative flex w-full max-w-[280px] items-center justify-center">
                <!-- Place holder to center call button -->
                <div class="w-16"></div>

                <!-- Call Button -->
                <button
                  class="shadow-call-accept duration-short ease-standard mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500 transition-colors hover:bg-green-400"
                  aria-label="Call"
                  onclick={() => startCall(enteredNumber)}
                >
                  <PhoneIcon class="text-on-surface h-8 w-8" />
                </button>

                <!-- Backspace -->
                <div class="flex w-16 justify-center">
                  {#if enteredNumber}
                    <button
                      class="text-on-surface-variant hover:text-on-surface duration-short ease-standard transition-colors"
                      onclick={handleBackspace}
                      aria-label="Backspace"
                    >
                      <BackspaceIcon class="h-8 w-8" />
                    </button>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        {:else}
          <!-- Recents -->
          <div class="scrollbar-none min-h-0 flex-1 overflow-y-auto px-4 pb-8">
            {#if $callLog.length === 0}
              <div
                class="text-on-surface-variant flex h-full flex-col items-center justify-center space-y-2 text-center"
              >
                <p class="text-body-large">No recent calls</p>
              </div>
            {:else}
              <div class="space-y-2 pt-2">
                {#each $callLog as entry (entry.id)}
                  <button
                    class="bg-surface hover:bg-surface-container duration-short ease-standard flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors"
                    onclick={() => startCall(entry.number, nameForNumber(entry.number))}
                  >
                    <Avatar
                      initials={nameForNumber(entry.number)[0]?.toUpperCase() || '#'}
                      size="w-10 h-10"
                      textClass="text-sm"
                    />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        {#if entry.kind === 'outgoing'}
                          <ArrowUpRightIcon class="text-on-surface-variant size-icon-sm" />
                        {:else if entry.kind === 'incoming'}
                          <ArrowDownLeftIcon class="text-on-surface-variant size-icon-sm" />
                        {:else}
                          <ArrowDownLeftIcon class="text-error size-icon-sm" />
                        {/if}
                        <span
                          class="truncate {entry.kind === 'missed'
                            ? 'text-error'
                            : 'text-on-surface'}"
                        >
                          {nameForNumber(entry.number)}
                        </span>
                      </div>
                      <p class="text-on-surface-variant text-body-small">
                        {formatCallTimestamp(entry.created_at)}
                      </p>
                    </div>
                    {#if entry.kind !== 'missed'}
                      <span class="text-on-surface-variant text-body-small shrink-0">
                        {formatDuration(entry.duration)}
                      </span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </Screen>
  {:else}
    <!-- In Call View -->
    <div
      class="animate-in fade-in duration-medium ease-emphasized flex flex-1 flex-col items-center bg-gradient-to-b from-gray-800 to-gray-900 pt-20 pb-12"
    >
      <!-- Avatar/Icon -->
      <Avatar
        initials={$callStore.name?.[0] || '#'}
        size="w-32 h-32"
        textClass="text-4xl text-on-surface-variant"
        bgClass="bg-surface-container-high shadow-elevation-5 mb-8"
      />

      <h2 class="mb-2 px-4 text-center text-3xl font-semibold">
        {$callStore.name || $callStore.number}
      </h2>
      <p class="text-on-surface-variant mb-12 text-lg">
        {#if $callStore.status === 'dialing'}
          Dialing...
        {:else if $callStore.status === 'connected'}
          {formatDuration($callStore.duration)}
        {:else if $callStore.status === 'incoming'}
          Incoming Call...
        {/if}
      </p>

      <!-- DTMF pad, shown over the call. Digits go nowhere yet — there is no server
           tone channel — so it echoes what was pressed rather than pretending. -->
      {#if showInCallKeypad}
        <div class="mb-8 grid w-full max-w-[260px] grid-cols-3 gap-4">
          {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as key (key)}
            <button
              class="bg-surface-container hover:bg-surface-container-high duration-short ease-standard flex h-14 w-14 cursor-pointer items-center justify-center justify-self-center rounded-full text-xl transition-colors"
              onclick={() => (dtmfEntered += key)}
            >
              {key}
            </button>
          {/each}
        </div>
        {#if dtmfEntered}
          <p class="text-on-surface-variant text-body-medium mb-4 font-mono tracking-widest">
            {dtmfEntered}
          </p>
        {/if}
      {/if}

      <!-- Controls -->
      <div class="mt-auto grid w-full max-w-[300px] grid-cols-3 gap-8">
        <!-- Mute. Both this and Keypad were decorative: styled, labeled, no onclick. -->
        <button
          onclick={() => callStore.toggleMute()}
          aria-pressed={$callStore.muted}
          class="flex flex-col items-center space-y-2 transition-colors {$callStore.muted
            ? 'text-on-surface'
            : 'text-on-surface-variant hover:text-on-surface'} duration-short ease-standard"
          aria-label="Mute"
        >
          <div
            class="rounded-full p-4 {$callStore.muted
              ? 'bg-white text-gray-900'
              : 'bg-surface-container'}"
          >
            <MicrophoneIcon />
          </div>
          <span class="text-body-small">{$callStore.muted ? 'Unmute' : 'Mute'}</span>
        </button>

        <!-- Keypad: purely local, so the in-call DTMF pad needs no plumbing. -->
        <button
          onclick={() => (showInCallKeypad = !showInCallKeypad)}
          aria-pressed={showInCallKeypad}
          class="flex flex-col items-center space-y-2 transition-colors {showInCallKeypad
            ? 'text-on-surface'
            : 'text-on-surface-variant hover:text-on-surface'} duration-short ease-standard"
          aria-label="Keypad"
        >
          <div
            class="rounded-full p-4 {showInCallKeypad
              ? 'bg-white text-gray-900'
              : 'bg-surface-container'}"
          >
            <KeypadIcon />
          </div>
          <span class="text-body-small">Keypad</span>
        </button>

        <!-- Speaker -->
        <button
          class="flex flex-col items-center space-y-2 transition-colors {$callStore.speaker
            ? 'text-on-surface'
            : 'text-on-surface-variant'} duration-short ease-standard"
          onclick={callStore.toggleSpeaker}
          aria-label="Speaker"
        >
          <div
            class="bg-surface-container rounded-full p-4 {$callStore.speaker
              ? 'bg-white text-gray-900'
              : ''}"
          >
            <SpeakerIcon />
          </div>
          <span class="text-body-small">Speaker</span>
        </button>
      </div>

      <!-- End Call -->
      <div class="mt-12 mb-8 flex justify-center space-x-8">
        {#if $callStore.status === 'incoming'}
          <button
            class="shadow-call-accept duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full bg-green-500 transition-colors hover:bg-green-400"
            onclick={() => callStore.answerCall()}
            aria-label="Answer Call"
          >
            <PhoneIcon class="text-on-surface h-8 w-8" />
          </button>
        {/if}

        <button
          class="bg-error shadow-call-end duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full transition-colors hover:bg-red-400"
          onclick={() => {
            // `endCall` returns the store to idle, and the effect at the top of this file
            // refetches Recents off that transition — for this button and for every other
            // way a call ends alike. It used to refetch here and nowhere else.
            void callStore.endCall();
          }}
          aria-label="End Call"
        >
          <PhoneIcon class="text-on-error h-8 w-8 rotate-135" />
        </button>
      </div>
    </div>
  {/if}
</div>
