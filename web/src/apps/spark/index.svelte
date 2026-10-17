<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    ConfirmDialog,
    EditIcon,
    HomeIcon,
    MessageIcon,
    ReportDialog,
    Screen,
    Skeleton,
    TabBar,
    onAppForeground,
    registerMessages,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useDeepLink,
    useLocale,
    useNotifications,
    type AppProps
  } from '@mica/sdk';
  import type { SparkCard, SparkMatch } from '@mica/shared/types';
  import {
    block,
    closeThread,
    deck,
    inbox,
    loadDeck,
    loadMatches,
    loadProfile,
    loadThreads,
    matches,
    matchesLoaded,
    openPeer,
    openThread,
    profile,
    profileLoaded,
    receiveDm,
    receiveUnmatched,
    refillDeck,
    removeProfile,
    saveProfile,
    swipe,
    unmatch,
    type SparkProfileInput
  } from './store';
  import Deck from './components/Deck.svelte';
  import MatchMenu from './components/MatchMenu.svelte';
  import Matches from './components/Matches.svelte';
  import ProfileCard from './components/ProfileCard.svelte';
  import ProfileEditor from './components/ProfileEditor.svelte';
  import Thread from './components/Thread.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // A `core: false` add-on ships its own catalog and reads every label through `$t('spark.…')`.
  registerMessages('spark', { en, de });
  const { t } = useLocale();

  /**
   * Deep links, as `server/services/Spark.ts` builds them: `spark?accountId=<id>` from a
   * message (the sender's Spark account) and `spark?matchId=<id>` from a new match. Both open
   * the thread with that match once the matches have loaded.
   */
  let {
    onback,
    accountId,
    matchId
  }: AppProps & { accountId?: number | string; matchId?: number | string } = $props();

  const { run, busy } = useAppAction('spark');
  const notifications = useNotifications('spark');
  const unreadNotifications = notifications.notificationsStore;

  const deckLoaded = deck.loaded;

  let tab = $state<'deck' | 'matches'>('deck');
  let editing = $state(false);
  /** The match whose thread is open, by id. */
  let openMatchId = $state<number | null>(null);
  let threadLoading = $state(false);
  let menu = $state(false);
  let viewingProfile = $state(false);
  let confirmingUnmatch = $state(false);
  let confirmingBlock = $state(false);
  let confirmingDelete = $state(false);
  /** The profile being reported, by profile id. Null when the dialog is closed. */
  let reportingProfile = $state<number | null>(null);
  /** A match just made by my like, shown once. */
  let justMatched = $state<SparkMatch | null>(null);
  /** A deep link's target, held until the matches it names have loaded. */
  let pending = $state<{ accountId: number } | { matchId: number } | null>(null);

  const openMatch = $derived($matches.find((m) => m.id === openMatchId) ?? null);
  const topCard = $derived($deck[0]);

  /** Everything past the profile, read once it is known there is one. */
  const loadAll = () => {
    void loadDeck().then(() => refillDeck());
    void loadMatches();
    void loadThreads();
    void notifications.load();
  };

  /**
   * Every visit, not once per session — the app is resident, so `onMount` would show whatever
   * was true the first time it was ever opened (§11). An open thread re-reads too, so a message
   * missed while away arrives.
   */
  onAppForeground('spark', () => {
    void loadProfile().then(() => {
      if (!$profile) return;
      loadAll();
      if ($openPeer !== null) void openThread($openPeer).catch(() => undefined);
    });
  });

  const showThread = async (match: SparkMatch) => {
    openMatchId = match.id;
    threadLoading = true;
    try {
      await run(() => openThread(match.profile.account_id), { title: $t('spark.title') });
    } finally {
      threadLoading = false;
    }
  };

  const leaveThread = () => {
    menu = false;
    viewingProfile = false;
    openMatchId = null;
    closeThread();
  };

  /**
   * Pushes while the app is on screen. A replay on mount is a catch-up, and `onAppForeground`
   * already reloads for it. Every handler merges by id, so my own send pushed back, or a match
   * my like already put in the list, is the same row rather than another.
   */
  const events = useAppEvents('spark');
  events.on<{ match_id: number }>('match', (event) => {
    if (event.replayed) return;
    void loadMatches();
    void loadThreads();
  });
  events.on<{ match_id: number }>('unmatched', (event) => {
    if (typeof event.payload.match_id === 'number') receiveUnmatched(event.payload.match_id);
  });
  events.on<{ peer_account_id: number }>('dm', (event) => {
    if (event.replayed || typeof event.payload.peer_account_id !== 'number') return;
    void receiveDm(event.payload.peer_account_id).catch(() => undefined);
  });

  /** The open thread went away underneath it — unmatched, blocked, deleted: back to the list. */
  $effect(() => {
    if ($matchesLoaded && openMatchId !== null && !openMatch) leaveThread();
  });

  useDeepLink('spark', () => {
    const byAccount = Number(accountId);
    const byMatch = Number(matchId);
    if (Number.isInteger(byAccount) && byAccount > 0) pending = { accountId: byAccount };
    else if (Number.isInteger(byMatch) && byMatch > 0) pending = { matchId: byMatch };
    else return false;
    tab = 'matches';
    return true;
  });

  $effect(() => {
    const wanted = pending;
    if (wanted === null || !$matchesLoaded) return;
    pending = null;
    const match = $matches.find((m) =>
      'accountId' in wanted ? m.profile.account_id === wanted.accountId : m.id === wanted.matchId
    );
    if (match) void showThread(match);
  });

  /** Reading the matches is reading what the badge counted: messages from matches. */
  $effect(() => {
    if (tab !== 'matches' && openMatchId === null) return;
    const ids = $unreadNotifications.filter((n) => !n.read_at).map((n) => n.id);
    if (ids.length > 0) void notifications.markRead(ids).catch(() => undefined);
  });

  const save = async (input: SparkProfileInput) => {
    const first = !$profile;
    const ok = await run(() => saveProfile(input), {
      title: $t('spark.title'),
      success: first ? undefined : $t('spark.saved')
    });
    if (!ok) return;
    editing = false;
    if (first) loadAll();
  };

  const doSwipe = async (card: SparkCard, verdict: 'like' | 'pass') => {
    let made = null as SparkMatch | null;
    await run(
      async () => {
        made = await swipe(card, verdict);
      },
      { title: $t('spark.title') }
    );
    if (made) justMatched = made;
  };

  const doUnmatch = async () => {
    const match = openMatch;
    if (!match) return;
    const ok = await run(() => unmatch(match), {
      title: $t('spark.title'),
      success: $t('spark.unmatched')
    });
    confirmingUnmatch = false;
    if (ok) leaveThread();
  };

  const doBlock = async () => {
    const match = openMatch;
    if (!match) return;
    const ok = await run(() => block(match.profile), {
      title: $t('spark.title'),
      success: $t('spark.blocked')
    });
    confirmingBlock = false;
    if (ok) leaveThread();
  };

  const doDelete = async () => {
    const ok = await run(() => removeProfile(), {
      title: $t('spark.title'),
      success: $t('spark.deleted')
    });
    confirmingDelete = false;
    if (ok) {
      editing = false;
      tab = 'deck';
      leaveThread();
    }
  };

  const messageMatch = () => {
    const match = justMatched;
    justMatched = null;
    if (!match) return;
    tab = 'matches';
    void showThread(match);
  };

  const selectTab = (next: string) => {
    if (next !== 'deck' && next !== 'matches') return;
    tab = next;
    if (tab === 'matches') {
      void loadMatches();
      void loadThreads();
    }
  };

  const app = useAppLevels({
    appId: 'spark',
    title: () => $t('spark.title'),
    onback: () => onback(),
    levels: [
      // Deepest first; every overlay its own rung, so Back closes it rather than leaving.
      { open: () => confirmingDelete, close: () => (confirmingDelete = false) },
      { open: () => confirmingUnmatch, close: () => (confirmingUnmatch = false) },
      { open: () => confirmingBlock, close: () => (confirmingBlock = false) },
      { open: () => justMatched !== null, close: () => (justMatched = null) },
      { open: () => menu, close: () => (menu = false), title: () => $t('spark.matchActions') },
      {
        open: () => viewingProfile,
        close: () => (viewingProfile = false),
        title: () => openMatch?.profile.display_name || $t('spark.title')
      },
      {
        open: () => openMatchId !== null,
        close: leaveThread,
        title: () => openMatch?.profile.display_name || $t('spark.title')
      },
      {
        open: () => editing,
        close: () => (editing = false),
        title: () => $t('spark.editTitle')
      },
      {
        open: () => tab !== 'deck',
        close: () => (tab = 'deck'),
        title: () => $t('spark.matches')
      }
    ]
  });

  const onTabs = $derived(!!$profile && !editing && openMatchId === null && justMatched === null);
</script>

{#snippet headerActions()}
  {#if $profile && !editing && openMatchId === null}
    <div class="ml-auto flex items-center">
      <button
        type="button"
        class="text-on-surface hover:bg-surface-container-high duration-short ease-standard cursor-pointer rounded-full p-2 transition-colors"
        aria-label={$t('spark.editProfile')}
        title={$t('spark.editProfile')}
        onclick={() => (editing = true)}
        data-testid="spark-edit-profile"
      >
        <EditIcon class="size-icon-sm" />
      </button>
    </div>
  {:else if openMatch && !viewingProfile}
    <div class="ml-auto flex items-center">
      <button
        type="button"
        class="text-on-surface hover:bg-surface-container-high duration-short ease-standard text-title-medium cursor-pointer rounded-full px-3 py-1 transition-colors"
        aria-label={$t('spark.matchActions')}
        title={$t('spark.matchActions')}
        onclick={() => (menu = true)}
        data-testid="spark-match-actions"
      >
        ⋯
      </button>
    </div>
  {/if}
{/snippet}

{#snippet overlays()}
  {#if menu && openMatch}
    <MatchMenu
      onprofile={() => {
        menu = false;
        viewingProfile = true;
      }}
      onunmatch={() => {
        menu = false;
        confirmingUnmatch = true;
      }}
      onblock={() => {
        menu = false;
        confirmingBlock = true;
      }}
      onreport={() => {
        menu = false;
        reportingProfile = openMatch?.profile.id ?? null;
      }}
      onclose={() => (menu = false)}
    />
  {/if}

  {#if justMatched}
    <div
      class="pt-safe-top animate-in fade-in bg-surface duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 p-6 pb-home-indicator text-center"
      data-testid="spark-matched"
    >
      <p class="text-primary text-title-large font-semibold">{$t('spark.matchedTitle')}</p>
      <p class="text-on-surface text-body-medium">
        {$t('spark.matchedMessage', {
          name: justMatched.profile.display_name || $t('spark.someone')
        })}
      </p>
      <Button class="w-full" onclick={messageMatch} data-testid="spark-matched-message">
        {$t('spark.sendMessage')}
      </Button>
      <Button
        variant="secondary"
        class="w-full"
        onclick={() => (justMatched = null)}
        data-testid="spark-keep-swiping"
      >
        {$t('spark.keepSwiping')}
      </Button>
    </div>
  {/if}

  {#if confirmingUnmatch && openMatch}
    <ConfirmDialog
      title={$t('spark.unmatchTitle', { name: openMatch.profile.display_name || '' })}
      message={$t('spark.unmatchMessage')}
      confirmText={$t('spark.unmatch')}
      confirmVariant="danger"
      isLoading={$busy}
      onconfirm={() => void doUnmatch()}
      oncancel={() => (confirmingUnmatch = false)}
    />
  {/if}

  {#if confirmingBlock && openMatch}
    <ConfirmDialog
      title={$t('spark.blockTitle', { name: openMatch.profile.display_name || '' })}
      message={$t('spark.blockMessage')}
      confirmText={$t('spark.block')}
      confirmVariant="danger"
      isLoading={$busy}
      onconfirm={() => void doBlock()}
      oncancel={() => (confirmingBlock = false)}
    />
  {/if}

  {#if confirmingDelete}
    <ConfirmDialog
      title={$t('spark.deleteTitle')}
      message={$t('spark.deleteMessage')}
      confirmText={$t('spark.deleteConfirm')}
      confirmVariant="danger"
      isLoading={$busy}
      onconfirm={() => void doDelete()}
      oncancel={() => (confirmingDelete = false)}
    />
  {/if}

  {#if reportingProfile !== null}
    <ReportDialog
      targetTable="mica_spark"
      targetId={reportingProfile}
      appId="spark"
      onclose={() => (reportingProfile = null)}
    />
  {/if}

  {#if onTabs}
    <TabBar
      aria-label={$t('spark.sections')}
      selected={tab}
      onchange={selectTab}
      options={[
        { id: 'deck', label: $t('spark.discover'), icon: HomeIcon },
        { id: 'matches', label: $t('spark.matches'), icon: MessageIcon }
      ]}
    />
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions} overlay={overlays}>
  {#if !$profileLoaded}
    <div class="p-4"><Skeleton count={2} height="h-64" /></div>
  {:else if !$profile}
    <!-- Nothing to swipe or match as yet. The editor is the first screen, not a dead deck. -->
    <ProfileEditor busy={$busy} onsave={(input: SparkProfileInput) => void save(input)} />
  {:else if editing}
    <ProfileEditor
      profile={$profile}
      busy={$busy}
      onsave={(input: SparkProfileInput) => void save(input)}
      oncancel={() => (editing = false)}
      ondelete={() => (confirmingDelete = true)}
    />
  {:else if openMatch && viewingProfile}
    <div class="min-h-0 flex-1 overflow-y-auto pb-home-indicator">
      <ProfileCard card={openMatch.profile} />
    </div>
  {:else if openMatch}
    <Thread match={openMatch} loading={threadLoading} />
  {:else if tab === 'matches'}
    <Matches
      rows={$inbox}
      loaded={$matchesLoaded}
      myAccountId={$profile.account_id}
      onopen={(match: SparkMatch) => void showThread(match)}
    />
  {:else}
    <Deck
      card={topCard}
      loaded={$deckLoaded}
      busy={$busy}
      onswipe={(card: SparkCard, verdict: 'like' | 'pass') => void doSwipe(card, verdict)}
      onreport={(card: SparkCard) => (reportingProfile = card.id)}
    />
  {/if}
</Screen>
