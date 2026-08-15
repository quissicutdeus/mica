<script lang="ts">
  import {
    onAppForeground,
    useCall,
    useContacts,
    Avatar,
    Screen,
    BackspaceIcon,
    KeypadIcon,
    MicrophoneIcon,
    PhoneIcon,
    SpeakerIcon,
    type AppProps
  } from '@gphone/sdk';

  const { callStore } = useCall();
  const { contactsStore, favoriteContacts } = useContacts();

  let { onback }: AppProps = $props();

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

  $effect(() => {
    if ($callStore.status === 'idle') {
      showInCallKeypad = false;
      dtmfEntered = '';
    }
  });

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Ensure contacts are loaded for favorites, on every visit rather than once.
  onAppForeground('phone', () => {
    void contactsStore.load();
  });
</script>

<div class="bg-surface text-on-surface relative flex h-full flex-col overflow-hidden">
  {#if $callStore.status === 'idle'}
    <!-- Keypad View -->
    <Screen title="Phone" {onback}>
      <div class="flex h-full flex-1 flex-col items-center justify-end p-8 pb-12">
        <!-- Favorites Bar -->
        {#if $favoriteContacts.length > 0}
          <div class="mt-4 mb-auto w-full">
            <div class="text-on-surface-variant text-body-small mb-2 ml-1 uppercase">Favorites</div>
            <div class="no-scrollbar flex space-x-4 overflow-x-auto pb-2">
              {#each $favoriteContacts as fav}
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

        <!-- Number Display -->
        <div class="mb-8 flex h-12 items-center text-4xl font-light">
          {enteredNumber}
        </div>

        <!-- Keypad -->
        <div class="grid w-full max-w-[280px] grid-cols-3 gap-6">
          {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as num}
            <button
              class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full text-2xl font-medium transition-colors"
              onclick={() => handleKeypad(num.toString())}
            >
              {num}
            </button>
          {/each}
          <button
            class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full text-2xl font-medium transition-colors"
            onclick={() => handleKeypad('*')}>*</button
          >
          <button
            class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full text-2xl font-medium transition-colors"
            onclick={() => handleKeypad('0')}>0</button
          >
          <button
            class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full text-2xl font-medium transition-colors"
            onclick={() => handleKeypad('#')}>#</button
          >
        </div>

        <div class="relative mt-8 flex w-full max-w-[280px] items-center justify-center">
          <!-- Place holder to center call button -->
          <div class="w-16"></div>

          <!-- Call Button -->
          <button
            class="shadow-elevation-3 duration-short ease-standard mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500 shadow-green-500/30 transition-colors hover:bg-green-400"
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
            class="shadow-elevation-3 duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full bg-green-500 shadow-green-500/30 transition-colors hover:bg-green-400"
            onclick={() => callStore.answerCall()}
            aria-label="Answer Call"
          >
            <PhoneIcon class="text-on-surface h-8 w-8" />
          </button>
        {/if}

        <button
          class="bg-error shadow-elevation-3 duration-short ease-standard flex h-16 w-16 items-center justify-center rounded-full shadow-red-500/30 transition-colors hover:bg-red-400"
          onclick={() => callStore.endCall()}
          aria-label="End Call"
        >
          <PhoneIcon class="text-on-surface h-8 w-8 rotate-135 transform" />
        </button>
      </div>
    </div>
  {/if}
</div>
