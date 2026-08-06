<script lang="ts">
  import {
    useAccount,
    useAdmin,
    onAppForeground,
    useAppLevels,
    useAppRegistry,
    useNuiBridge,
    usePhoneNotification,
    Screen,
    ChevronRightIcon,
    useDevTools,
    useTimer,
    type AppProps
  } from '@gphone/sdk';
  import About from './panes/About.svelte';
  import AppInfo from './panes/AppInfo.svelte';
  import Apps from './panes/Apps.svelte';
  import Display from './panes/Display.svelte';
  import Network from './panes/Network.svelte';
  import Notifications from './panes/Notifications.svelte';
  import DeveloperTools from './panes/DeveloperTools.svelte';
  import Shortcuts from './panes/Shortcuts.svelte';
  import Sound from './panes/Sound.svelte';
  import WallpaperPane from './panes/WallpaperPane.svelte';

  let { onback }: AppProps = $props();

  const { fetchPhoneNumber } = useAccount();
  const { toast } = usePhoneNotification();
  const { fetchNui } = useNuiBridge();
  const { devToolsUnlocked } = useDevTools();
  const { refreshAdmin } = useAdmin();

  /**
   * Settings is a hub, not one long scroll: each group is its own pane.
   *
   * Panes are local state rather than separate registry apps because they are Settings'
   * own screens, and because `App.svelte` re-keys on `currentApp.name` — routing through
   * the registry would destroy and rebuild the whole module on every drill-in.
   */
  type Pane =
    | 'root'
    | 'network'
    | 'notifications'
    | 'apps'
    | 'wallpaper'
    | 'display'
    | 'sound'
    | 'shortcuts'
    | 'devtools'
    | 'about';
  let pane = $state<Pane>('root');

  const PANE_TITLES: Record<Pane, string> = {
    root: 'Settings',
    network: 'Network',
    notifications: 'Notifications',
    apps: 'Apps',
    wallpaper: 'Wallpaper & Theme',
    display: 'Display',
    sound: 'Sound',
    shortcuts: 'Shortcuts',
    devtools: 'Developer Tools',
    about: 'About'
  };

  /**
   * Which app's details are open, inside the Apps pane.
   *
   * Held here rather than in the pane because `useAppLevels` lives here, and a screen that is
   * not a rung is a screen Back walks straight past — from an app's details to the Settings
   * root, skipping the list (§2.7).
   */
  let selectedAppId = $state<string | null>(null);
  const { registryStore } = useAppRegistry();
  const selectedApp = $derived($registryStore.find((a) => a.id === selectedAppId) ?? null);

  // Back steps up one pane before it will leave, and the Back keybind is claimed as part
  // of saying so — Escape would otherwise jump straight home from inside a pane.
  const app = useAppLevels({
    appId: 'settings',
    title: 'Settings',
    onback: () => onback(),
    levels: [
      // Deepest first: out of an app's details, then out of the pane, then out of Settings.
      {
        open: () => selectedApp !== null,
        close: () => (selectedAppId = null),
        title: () => selectedApp?.name ?? 'App'
      },
      {
        open: () => pane !== 'root',
        close: () => {
          pane = 'root';
          selectedAppId = null;
        },
        title: () => PANE_TITLES[pane]
      }
    ]
  });

  /**
   * Ten taps on the OS Version row reveals Developer Tools, the way Android reveals its
   * developer options.
   *
   * The flag lives in a module-scope store rather than here, and is not persisted — see
   * `store/devtools.ts`. It resets when the phone closes, so the row is absent on every
   * fresh open until the taps are done again.
   */
  let devToolsTaps = $state(0);
  let cancelTapReset: (() => void) | undefined;
  const { after } = useTimer();

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
    cancelTapReset?.();
    // Taps must be consecutive; drifting off resets the count.
    cancelTapReset = after(2000, () => (devToolsTaps = 0));

    const remaining = TAPS_TO_UNLOCK - devToolsTaps;
    const title = 'Developer Tools';

    if (remaining <= 0) {
      devToolsUnlocked.set(true);
      devToolsTaps = 0;
      cancelTapReset?.();
      toast.show({ type: 'success', title, message: 'Developer Tools unlocked' });
    } else if (remaining <= 3) {
      toast.show({ type: 'info', title, message: `${remaining} more to unlock Developer Tools` });
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

  // Admin status is granted server-side and can change between visits.
  onAppForeground('settings', () => {
    void fetchPhoneNumber();
    void refreshAdmin();
  });
</script>

<Screen title={app.title} onback={app.back}>
  {#if pane === 'network'}
    <Network />
  {:else if pane === 'notifications'}
    <Notifications />
  {:else if pane === 'apps'}
    {#if selectedApp}
      <AppInfo app={selectedApp} onremoved={() => (selectedAppId = null)} />
    {:else}
      <Apps onselect={(id) => (selectedAppId = id)} />
    {/if}
  {:else if pane === 'wallpaper'}
    <WallpaperPane />
  {:else if pane === 'display'}
    <Display />
  {:else if pane === 'sound'}
    <Sound />
  {:else if pane === 'shortcuts'}
    <Shortcuts />
  {:else if pane === 'devtools'}
    <DeveloperTools onhide={hideDevTools} />
  {:else if pane === 'about'}
    <About ontapbuild={tapBuildRow} />
  {:else}
    <div class="p-4">
      <div
        class="divide-outline-variant bg-surface-container divide-y overflow-hidden rounded-xl text-sm"
      >
        <button
          type="button"
          onclick={() => (pane = 'network')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">Network</span>
            <span class="text-on-surface-variant text-xs"
              >Cellular service and Bluetooth proximity</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'notifications')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">Notifications</span>
            <span class="text-on-surface-variant text-xs"
              >Banners, alerts, sounds, and icon badges</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'apps')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">Apps</span>
            <span class="text-on-surface-variant text-xs">Storage and uninstall, per app</span>
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'wallpaper')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">Wallpaper & Theme</span>
            <span class="text-on-surface-variant text-xs"
              >Background, and the colour the phone is built from</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'display')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">Display</span>
            <span class="text-on-surface-variant text-xs">Phone size, clock, and time format</span>
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'sound')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">Sound</span>
            <span class="text-on-surface-variant text-xs">Volume, mute, and button step size</span>
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'shortcuts')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">Shortcuts</span>
            <span class="text-on-surface-variant text-xs">Keyboard shortcuts inside the phone</span>
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'about')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">About</span>
            <span class="text-on-surface-variant text-xs">Number, build, and first boot</span>
          </div>
          <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
        </button>
        {#if showDevTools}
          <button
            type="button"
            onclick={() => (pane = 'devtools')}
            class="hover:bg-surface-container-hover active:bg-surface-container-pressed flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
          >
            <div class="flex flex-col">
              <span class="text-on-surface font-medium">Developer Tools</span>
              <span class="text-on-surface-variant text-xs"
                >Battery, signal, and event simulation</span
              >
            </div>
            <ChevronRightIcon class="text-on-surface-variant h-4 w-4" />
          </button>
        {/if}
      </div>
    </div>
  {/if}
</Screen>
