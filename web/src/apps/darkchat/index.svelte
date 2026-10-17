<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    ConfirmDialog,
    Screen,
    UsersIcon,
    onAppForeground,
    registerMessages,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useLocale,
    type AppProps
  } from '@mica/sdk';
  import type { DarkchatChannel, DarkchatJoined } from '@mica/shared/types';
  import {
    channels,
    channelsLoaded,
    createChannel,
    joinChannel,
    leaveChannel,
    loadChannels,
    loadMessages,
    messages,
    receiveMessage,
    receiveRemoval
  } from './store';
  import ChannelForm from './components/ChannelForm.svelte';
  import ChannelInfo from './components/ChannelInfo.svelte';
  import ChannelList from './components/ChannelList.svelte';
  import CodeCard from './components/CodeCard.svelte';
  import Thread from './components/Thread.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // A `core: false` add-on ships its own catalog and reads every label through `$t('darkchat.…')`.
  registerMessages('darkchat', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  const { run, busy } = useAppAction('darkchat');

  let view = $state<'list' | 'create' | 'join' | 'thread' | 'info'>('list');
  let activeId = $state<number | null>(null);
  let threadLoading = $state(false);
  /** A channel just created, and its code — shown once, then the thread. */
  let fresh = $state<{ channel: DarkchatChannel; code: string } | null>(null);
  let confirmingLeave = $state(false);

  const active = $derived($channels.find((c) => c.id === activeId) ?? null);

  const openThread = async (channelId: number) => {
    activeId = channelId;
    view = 'thread';
    threadLoading = true;
    try {
      const ok = await run(() => loadMessages(channelId), { title: $t('darkchat.title') });
      // Refused most likely because I am no longer in it: the list says so on its next read.
      if (!ok) void loadChannels();
    } finally {
      threadLoading = false;
    }
  };

  /**
   * Every visit, not once per session — the app is resident, so `onMount` would show whatever
   * was true the first time it was ever opened (§11). An open thread re-reads too: lines past
   * the retention window have to leave it, and a push missed while away has to arrive.
   */
  onAppForeground('darkchat', () => {
    void loadChannels();
    if (activeId !== null && (view === 'thread' || view === 'info')) {
      void loadMessages(activeId).catch(() => void loadChannels());
    }
  });

  /**
   * A new line in a channel I am in. The store merges by id, so a replay on mount, or my own
   * send arriving a second time, is the same bubble rather than another.
   */
  const events = useAppEvents('darkchat');
  events.on('message', (event) => receiveMessage(event.payload));
  // Removed by the owner: the channel goes, and the effect below takes an open one with it.
  events.on('removed', (event) => receiveRemoval(event.payload));

  /** Removed, or left from another phone: an open channel that is gone drops back to the list. */
  $effect(() => {
    if ($channelsLoaded && activeId !== null && !active && fresh === null) {
      if (view === 'thread' || view === 'info') view = 'list';
      activeId = null;
    }
  });

  const submitForm = async (first: string, alias: string) => {
    const creating = view === 'create';
    let joined = null as DarkchatJoined | null;
    const ok = await run(
      async () => {
        joined = creating ? await createChannel(first, alias) : await joinChannel(first, alias);
      },
      { title: $t('darkchat.title') }
    );
    if (!ok || !joined) return;
    if (creating && joined.code) {
      fresh = { channel: joined.channel, code: joined.code };
      return;
    }
    void openThread(joined.channel.id);
  };

  const finishCreate = () => {
    const created = fresh;
    fresh = null;
    if (created) void openThread(created.channel.id);
    else view = 'list';
  };

  const leave = async () => {
    const channel = active;
    if (!channel) return;
    const ok = await run(() => leaveChannel(channel.id), {
      title: $t('darkchat.title'),
      success: $t('darkchat.left', { name: channel.name })
    });
    confirmingLeave = false;
    if (ok) {
      activeId = null;
      view = 'list';
    }
  };

  const app = useAppLevels({
    appId: 'darkchat',
    title: () => $t('darkchat.title'),
    onback: () => onback(),
    levels: [
      // Deepest first; every overlay its own rung, so Back closes it rather than leaving.
      { open: () => confirmingLeave, close: () => (confirmingLeave = false) },
      { open: () => fresh !== null, close: finishCreate, title: () => $t('darkchat.newChannel') },
      {
        open: () => view === 'info',
        close: () => (view = 'thread'),
        title: () => $t('darkchat.info')
      },
      {
        open: () => view === 'thread',
        close: () => {
          view = 'list';
          activeId = null;
        },
        title: () => active?.name ?? $t('darkchat.title')
      },
      {
        open: () => view === 'create',
        close: () => (view = 'list'),
        title: () => $t('darkchat.newChannel')
      },
      {
        open: () => view === 'join',
        close: () => (view = 'list'),
        title: () => $t('darkchat.joinChannel')
      }
    ]
  });
</script>

{#snippet headerActions()}
  {#if view === 'thread' && active && fresh === null}
    <div class="ml-auto flex items-center">
      <button
        type="button"
        class="text-on-surface hover:bg-surface-container-high duration-short ease-standard cursor-pointer rounded-full p-2 transition-colors"
        aria-label={$t('darkchat.openInfo')}
        title={$t('darkchat.openInfo')}
        onclick={() => (view = 'info')}
        data-testid="darkchat-info"
      >
        <UsersIcon class="size-icon-sm" />
      </button>
    </div>
  {/if}
{/snippet}

{#snippet overlays()}
  {#if confirmingLeave && active}
    <ConfirmDialog
      title={$t('darkchat.leaveTitle', { name: active.name })}
      message={$t('darkchat.leaveMessage')}
      confirmText={$t('darkchat.leaveConfirm')}
      confirmVariant="danger"
      isLoading={$busy}
      onconfirm={() => void leave()}
      oncancel={() => (confirmingLeave = false)}
    />
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions} overlay={overlays}>
  {#if fresh}
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6 pb-home-indicator">
      <div class="space-y-1 text-center">
        <p class="text-on-surface text-title-medium font-medium">
          {$t('darkchat.codeTitle', { name: fresh.channel.name })}
        </p>
        <p class="text-on-surface-variant text-body-small">{$t('darkchat.codeOnce')}</p>
      </div>
      <CodeCard code={fresh.code} />
      <Button class="w-full" onclick={finishCreate}>{$t('darkchat.done')}</Button>
    </div>
  {:else if view === 'create' || view === 'join'}
    {#key view}
      <ChannelForm
        mode={view}
        busy={$busy}
        onsubmit={(first: string, alias: string) => void submitForm(first, alias)}
        oncancel={() => (view = 'list')}
      />
    {/key}
  {:else if view === 'info' && active}
    <ChannelInfo channel={active} onleave={() => (confirmingLeave = true)} />
  {:else if view === 'thread' && active}
    <Thread channel={active} rows={$messages[active.id]} loading={threadLoading} />
  {:else}
    <ChannelList
      channels={$channels}
      loaded={$channelsLoaded}
      onopen={(channel: DarkchatChannel) => void openThread(channel.id)}
      oncreate={() => (view = 'create')}
      onjoin={() => (view = 'join')}
    />
  {/if}
</Screen>
