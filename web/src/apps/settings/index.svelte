<!--
SPDX-FileCopyrightText: 2025 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    useAccount,
    useAdmin,
    onAppForeground,
    useAppLevels,
    useAppRegistry,
    usePhoneNotification,
    Screen,
    ChevronRightIcon,
    useDevTools,
    useLocale,
    useTimer,
    type AppProps
  } from '@gos/sdk';
  import About from './panes/About.svelte';
  import AppInfo from './panes/AppInfo.svelte';
  import Apps from './panes/Apps.svelte';
  import Display from './panes/Display.svelte';
  import LockScreen from './panes/LockScreen.svelte';
  import Network from './panes/Network.svelte';
  import Notifications from './panes/Notifications.svelte';
  import License from './panes/License.svelte';
  import Privacy from './panes/Privacy.svelte';
  import DeveloperTools from './panes/DeveloperTools.svelte';
  import Shortcuts from './panes/Shortcuts.svelte';
  import Sound from './panes/Sound.svelte';
  import Language from './panes/Language.svelte';
  import { registerMessages } from '@gos/sdk';
  import { createDevToolsUnlock } from './devToolsUnlock';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-61: Settings' own strings, every pane of them (MICA-214). Registered here,
  // once, so every pane below reads them through `$t('settings.…')`.
  registerMessages('settings', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  const { fetchPhoneNumber } = useAccount();
  const { toast } = usePhoneNotification();
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
    | 'display'
    | 'sound'
    | 'language'
    | 'lockscreen'
    | 'shortcuts'
    | 'devtools'
    | 'about'
    | 'privacy'
    | 'license';
  let pane = $state<Pane>('root');

  /**
   * A pane's title is a catalog key rather than a literal (MICA-214), read through `$t`
   * at the moment it is asked for — `useAppLevels` calls these lazily, so a title picked up
   * eagerly would be frozen in whichever language was active when Settings first mounted.
   */
  const PANE_TITLE_KEYS: Record<Pane, string> = {
    root: 'settings.title',
    network: 'settings.network.title',
    notifications: 'settings.notifications.title',
    apps: 'settings.apps.title',
    display: 'settings.display.title',
    sound: 'settings.sound.title',
    language: 'settings.language.title',
    lockscreen: 'settings.lockscreen.title',
    shortcuts: 'settings.shortcuts.title',
    devtools: 'settings.devtools.title',
    about: 'settings.about.title',
    privacy: 'settings.privacy.title',
    license: 'settings.license.title'
  };
  const paneTitle = (which: Pane): string => $t(PANE_TITLE_KEYS[which]);

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
    title: () => $t('settings.title'),
    onback: () => onback(),
    levels: [
      // Deepest first: out of an app's details, then out of the pane, then out of Settings.
      //
      // Privacy is the one pane reached from inside another, so Back returns to About
      // rather than to the root list. Without its own level the generic one below would
      // match -- `pane !== 'root'` is true here too -- and drop the player two screens.
      {
        open: () => pane === 'privacy',
        close: () => (pane = 'about'),
        title: () => paneTitle('privacy')
      },
      // License is reached from About too, and needs its own level for the same reason.
      {
        open: () => pane === 'license',
        close: () => (pane = 'about'),
        title: () => paneTitle('license')
      },
      {
        open: () => selectedApp !== null,
        close: () => (selectedAppId = null),
        title: () => selectedApp?.name ?? $t('settings.apps.detailFallback')
      },
      {
        open: () => pane !== 'root',
        close: () => {
          pane = 'root';
          selectedAppId = null;
        },
        title: () => paneTitle(pane)
      }
    ]
  });

  const { after } = useTimer();

  /**
   * Admin status comes from the shared store rather than a private fetch.
   *
   * Settings and the home screen both need this answer, and two copies of one fact
   * drift. It decides what is *shown*; the privileged actions behind it are gated again
   * server-side, because a NUI request is not proof of intent (AGENTS.md §2.9).
   */
  const { isAdmin } = useAdmin();

  // The ten-taps unlock is shared with the tablet root, so it lives in its own module
  // (MICA-261) and is handed the hooks only a component can resolve.
  const devTools = createDevToolsUnlock({ t, toast, devToolsUnlocked, isAdmin, after });

  /** The row only appears with the ace *and* the ten taps — in a browser too. */
  const showDevTools = $derived($isAdmin && $devToolsUnlocked);

  const hideDevTools = () => {
    devTools.hide();
    pane = 'root';
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
      <Apps onselect={(id: string) => (selectedAppId = id)} />
    {/if}
  {:else if pane === 'display'}
    <Display />
  {:else if pane === 'sound'}
    <Sound />
  {:else if pane === 'language'}
    <Language />
  {:else if pane === 'lockscreen'}
    <LockScreen />
  {:else if pane === 'shortcuts'}
    <Shortcuts />
  {:else if pane === 'devtools'}
    <DeveloperTools onhide={hideDevTools} />
  {:else if pane === 'about'}
    <About
      ontapbuild={devTools.tap}
      onprivacy={() => (pane = 'privacy')}
      onlicense={() => (pane = 'license')}
    />
  {:else if pane === 'privacy'}
    <Privacy />
  {:else if pane === 'license'}
    <License />
  {:else}
    <div class="p-4">
      <div
        class="divide-outline-variant bg-surface-container text-body-medium divide-y overflow-hidden rounded-box"
      >
        <button
          type="button"
          onclick={() => (pane = 'network')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.network.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.network.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'notifications')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.notifications.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.notifications.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'apps')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.apps.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.apps.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'display')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.display.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.display.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'sound')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.sound.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.sound.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'language')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.language.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.language.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'lockscreen')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.lockscreen.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.lockscreen.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'shortcuts')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.shortcuts.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.shortcuts.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        <button
          type="button"
          onclick={() => (pane = 'about')}
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        >
          <div class="flex flex-col">
            <span class="text-on-surface font-medium">{$t('settings.about.title')}</span>
            <span class="text-on-surface-variant text-body-small"
              >{$t('settings.about.subtitle')}</span
            >
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
        </button>
        {#if showDevTools}
          <button
            type="button"
            onclick={() => (pane = 'devtools')}
            class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
          >
            <div class="flex flex-col">
              <span class="text-on-surface font-medium">{$t('settings.devtools.title')}</span>
              <span class="text-on-surface-variant text-body-small"
                >{$t('settings.devtools.subtitle')}</span
              >
            </div>
            <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
          </button>
        {/if}
      </div>
    </div>
  {/if}
</Screen>
