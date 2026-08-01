<script lang="ts">
  import { onMount } from 'svelte';
  import {
    useAccount,
    useAdmin,
    useKeybinds,
    useNuiBridge,
    usePhoneNotification,
    Screen,
    ChevronRightIcon,
    isBrowser,
    useDevTools
  } from '@gphone/sdk';
  import About from './panes/About.svelte';
  import Display from './panes/Display.svelte';
  import DeveloperTools from './panes/DeveloperTools.svelte';
  import Shortcuts from './panes/Shortcuts.svelte';
  import Sound from './panes/Sound.svelte';

  let { onback } = $props<{ onback?: () => void }>();

  const { fetchPhoneNumber } = useAccount();
  const { toast } = usePhoneNotification();
  const { fetchNui } = useNuiBridge();
  const { onKeybind } = useKeybinds();
  const { devToolsUnlocked } = useDevTools();
  const { refreshAdmin } = useAdmin();

  /**
   * Settings is a hub, not one long scroll: each group is its own pane.
   *
   * Panes are local state rather than separate registry apps because they are Settings'
   * own screens, and because `App.svelte` re-keys on `currentApp.name` — routing through
   * the registry would destroy and rebuild the whole module on every drill-in.
   */
  type Pane = 'root' | 'display' | 'sound' | 'shortcuts' | 'devtools' | 'about';
  let pane = $state<Pane>('root');

  const PANE_TITLES: Record<Pane, string> = {
    root: 'Settings',
    display: 'Display',
    sound: 'Sound',
    shortcuts: 'Shortcuts',
    devtools: 'Developer Tools',
    about: 'About'
  };

  /** Back goes up one level first, and only then out of the app. */
  const goBack = () => {
    if (pane !== 'root') {
      pane = 'root';
    } else {
      onback?.();
    }
  };

  // Claim the Back keybind while Settings is mounted so Escape steps up a pane instead
  // of jumping straight home. The shell's own handler is underneath on the stack and
  // takes over again the moment this component unmounts.
  onKeybind('back', goBack);

  /**
   * Ten taps on the OS Version row reveals Developer Tools, the way Android reveals its
   * developer options.
   *
   * The flag lives in a module-scope store rather than here, and is not persisted — see
   * `store/devtools.ts`. It resets when the phone closes, so the row is absent on every
   * fresh open until the taps are done again.
   */
  let devToolsTaps = $state(0);
  let tapResetTimer: ReturnType<typeof setTimeout> | undefined;

  const TAPS_TO_UNLOCK = 10;

  /**
   * Admin status comes from the shared store rather than a private fetch.
   *
   * Settings and the home screen both need this answer, and two copies of one fact
   * drift. It decides what is *shown*; the privileged actions behind it are gated again
   * server-side, because a NUI request is not proof of intent (AGENTS.md §2.9).
   */
  const { isAdmin } = useAdmin();

  const tapBuildRow = () => {
    if ($devToolsUnlocked) return;

    if (!$isAdmin) {
      // Say so outright. Silently counting to ten and then showing nothing reads as a
      // broken build.
      toast.show({ type: 'error', message: 'Developer Tools require the gphone.admin permission' });
      return;
    }

    devToolsTaps += 1;
    clearTimeout(tapResetTimer);
    // Taps must be consecutive; drifting off resets the count.
    tapResetTimer = setTimeout(() => (devToolsTaps = 0), 2000);

    const remaining = TAPS_TO_UNLOCK - devToolsTaps;

    if (remaining <= 0) {
      devToolsUnlocked.set(true);
      devToolsTaps = 0;
      clearTimeout(tapResetTimer);
      toast.show({ type: 'success', message: 'Developer Tools unlocked' });
    } else if (remaining <= 3) {
      toast.show({ type: 'info', message: `${remaining} more to unlock Developer Tools` });
    }
  };

  /** The row only appears with the ace *and* the ten taps — in a browser too. */
  const showDevTools = $derived($isAdmin && $devToolsUnlocked);

  const hideDevTools = () => {
    devToolsUnlocked.set(false);
    devToolsTaps = 0;
    pane = 'root';
    toast.show({ type: 'info', message: 'Developer Tools hidden — tap OS Version 10x to restore' });
  };

  onMount(() => {
    fetchPhoneNumber();
    void refreshAdmin();
  });
</script>

<Screen title={PANE_TITLES[pane]} onback={goBack}>
  {#if pane === 'sound'}
    <Sound />
  {:else if pane === 'shortcuts'}
    <Shortcuts />
  {:else if pane === 'devtools'}
    <DeveloperTools onhide={hideDevTools} />
  {:else if pane === 'display'}
    <Display />
  {:else if pane === 'about'}
    <About ontapbuild={tapBuildRow} />
  {:else}
    <div class="space-y-6 p-4">
      <!-- Every setting lives in a group; the root is nothing but the way in. -->
      <div>
        <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">System</h2>
        <div class="divide-y divide-gray-700 overflow-hidden rounded-xl bg-gray-800 text-sm">
          <button
            type="button"
            onclick={() => (pane = 'display')}
            class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
          >
            <div class="flex flex-col">
              <span class="font-medium text-gray-200">Display</span>
              <span class="text-xs text-gray-400">Clock and time format</span>
            </div>
            <ChevronRightIcon class="h-4 w-4 text-gray-500" />
          </button>
          <button
            type="button"
            onclick={() => (pane = 'sound')}
            class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
          >
            <div class="flex flex-col">
              <span class="font-medium text-gray-200">Sound</span>
              <span class="text-xs text-gray-400">Volume, mute, and button step size</span>
            </div>
            <ChevronRightIcon class="h-4 w-4 text-gray-500" />
          </button>
          <button
            type="button"
            onclick={() => (pane = 'shortcuts')}
            class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
          >
            <div class="flex flex-col">
              <span class="font-medium text-gray-200">Shortcuts</span>
              <span class="text-xs text-gray-400">Keyboard shortcuts inside the phone</span>
            </div>
            <ChevronRightIcon class="h-4 w-4 text-gray-500" />
          </button>
          <button
            type="button"
            onclick={() => (pane = 'about')}
            class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
          >
            <div class="flex flex-col">
              <span class="font-medium text-gray-200">About</span>
              <span class="text-xs text-gray-400">Number, build, and first boot</span>
            </div>
            <ChevronRightIcon class="h-4 w-4 text-gray-500" />
          </button>
          {#if showDevTools}
            <button
              type="button"
              onclick={() => (pane = 'devtools')}
              class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
            >
              <div class="flex flex-col">
                <span class="font-medium text-gray-200">Developer Tools</span>
                <span class="text-xs text-gray-400">Battery, signal, and event simulation</span>
              </div>
              <ChevronRightIcon class="h-4 w-4 text-gray-500" />
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</Screen>
