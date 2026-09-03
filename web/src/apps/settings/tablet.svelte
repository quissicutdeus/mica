<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

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
    useDevTools,
    useLocale,
    useTimer,
    registerMessages,
    type AppProps
  } from '@gphone/sdk';
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
  import { createDevToolsUnlock } from './devToolsUnlock';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // The same catalog the phone root registers, under the same id (MICA-61/MICA-214).
  // Only one root is ever rendered, and registering a catalog twice is a merge, not a
  // conflict — so this is the honest thing to do rather than importing the other root for
  // its side effect.
  registerMessages('settings', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  const { fetchPhoneNumber } = useAccount();
  const { toast } = usePhoneNotification();
  const { devToolsUnlocked } = useDevTools();
  const { refreshAdmin, isAdmin } = useAdmin();
  const { after } = useTimer();

  /**
   * The tablet shows the list and the pane at once (MICA-261).
   *
   * The phone drills in: a root list, then one pane filling the screen, and Back walks
   * back up. At 1280x800 that would be a 400px-wide column of rows with two thirds of the
   * frame empty beside it, so the wide root is the two-pane shape instead — the sections
   * on the left, the selected one on the right, and no root screen at all. That last part
   * is why the `useAppLevels` ladder below is shorter than the phone's: there is nothing
   * above a pane to go back *to*, so Back at the top leaves Settings.
   */
  type Pane =
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

  // Display rather than the first row: it is what a player opens Settings for most often,
  // and something has to be selected when there is no empty state to fall back on.
  let pane = $state<Pane>('display');

  /**
   * A pane's title is a catalog key rather than a literal (MICA-214), read through `$t`
   * at the moment it is asked for — `useAppLevels` calls these lazily, so a title picked up
   * eagerly would be frozen in whichever language was active when Settings first mounted.
   */
  const PANE_TITLE_KEYS: Record<Pane, string> = {
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
   * The sidebar, in the phone root's order. Privacy and License are absent deliberately:
   * they are reached from inside About on both devices, and a row for each would make the
   * list disagree with the phone about what a section is.
   */
  const SIDEBAR: readonly { id: Pane; subtitleKey: string }[] = [
    { id: 'network', subtitleKey: 'settings.network.subtitle' },
    { id: 'notifications', subtitleKey: 'settings.notifications.subtitle' },
    { id: 'apps', subtitleKey: 'settings.apps.subtitle' },
    { id: 'display', subtitleKey: 'settings.display.subtitle' },
    { id: 'sound', subtitleKey: 'settings.sound.subtitle' },
    { id: 'language', subtitleKey: 'settings.language.subtitle' },
    { id: 'lockscreen', subtitleKey: 'settings.lockscreen.subtitle' },
    { id: 'shortcuts', subtitleKey: 'settings.shortcuts.subtitle' },
    { id: 'about', subtitleKey: 'settings.about.subtitle' }
  ];

  /**
   * Which app's details are open, inside the Apps pane.
   *
   * Held here rather than in the pane because `useAppLevels` lives here, and a screen that
   * is not a rung is a screen Back walks straight past (§2.7).
   */
  let selectedAppId = $state<string | null>(null);
  const { registryStore } = useAppRegistry();
  const selectedApp = $derived($registryStore.find((a) => a.id === selectedAppId) ?? null);

  const app = useAppLevels({
    appId: 'settings',
    title: () => $t('settings.title'),
    onback: () => onback(),
    levels: [
      // Deepest first. Privacy and License are both reached from inside About, so Back
      // returns there rather than to whatever was selected before.
      {
        open: () => pane === 'privacy',
        close: () => (pane = 'about'),
        title: () => paneTitle('privacy')
      },
      {
        open: () => pane === 'license',
        close: () => (pane = 'about'),
        title: () => paneTitle('license')
      },
      {
        open: () => selectedApp !== null,
        close: () => (selectedAppId = null),
        title: () => selectedApp?.name ?? $t('settings.apps.detailFallback')
      }
      // No `pane !== 'root'` rung: the list never goes away here, so there is no root
      // screen to return to and Back at this point leaves the app.
    ]
  });

  // Shared with the phone root, counter, timer, toasts and all (MICA-261).
  const devTools = createDevToolsUnlock({ t, toast, devToolsUnlocked, isAdmin, after });

  /** The row only appears with the ace *and* the ten taps — in a browser too. */
  const showDevTools = $derived($isAdmin && $devToolsUnlocked);

  const select = (which: Pane) => {
    pane = which;
    selectedAppId = null;
  };

  const hideDevTools = () => {
    devTools.hide();
    select('display');
  };

  // Admin status is granted server-side and can change between visits.
  onAppForeground('settings', () => {
    void fetchPhoneNumber();
    void refreshAdmin();
  });
</script>

<!-- One sidebar row. Selected is `primary-container`, the one filled role in the list, so
     the eye finds the open section without reading; the rest are quiet until hovered. -->
{#snippet sidebarRow(which: Pane, subtitleKey: string)}
  {@const selected = pane === which}
  <button
    type="button"
    onclick={() => select(which)}
    aria-current={selected ? 'page' : undefined}
    class="duration-short ease-standard flex w-full cursor-pointer flex-col rounded-box px-3 py-2.5 text-left transition-colors {selected
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface hover:bg-surface-container-high active:bg-surface-container-high-pressed'}"
  >
    <span class="font-medium">{paneTitle(which)}</span>
    <span class="text-body-small {selected ? '' : 'text-on-surface-variant'}"
      >{$t(subtitleKey)}</span
    >
  </button>
{/snippet}

<Screen title={app.title} onback={app.back}>
  <div class="flex min-h-0 flex-1">
    <!-- The list. `shrink-0` because the right pane is the one that gives: a section title
         that wraps mid-word is worse than a narrower detail pane. -->
    <nav
      aria-label={$t('settings.tablet.sections')}
      class="bg-surface-container text-body-medium w-72 shrink-0 space-y-1 overflow-y-auto p-3 pb-home-indicator"
    >
      {#each SIDEBAR as row (row.id)}
        {@render sidebarRow(row.id, row.subtitleKey)}
      {/each}
      {#if showDevTools}
        {@render sidebarRow('devtools', 'settings.devtools.subtitle')}
      {/if}
    </nav>

    <!-- The pane itself, scrolling on its own so the list stays put. Every component under
         `panes/` is the phone's, unchanged: they are already a column that fills its
         parent, and none of them assumes a 400px frame. `pb-home-indicator` so the last
         thing in a long pane can scroll clear of the gesture bar. -->
    <div class="min-w-0 flex-1 overflow-y-auto pb-home-indicator">
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
      {/if}
    </div>
  </div>
</Screen>
