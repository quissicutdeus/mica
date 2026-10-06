<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { MESSAGE_BODY_MAX } from '@mica/shared/contracts/messages';
  import {
    EmptyState,
    MessageBar,
    Screen,
    Skeleton,
    onAppForeground,
    registerMessages,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useCall,
    useContacts,
    useJobs,
    useLocale,
    type AppProps,
    type JobActionOutcome
  } from '@mica/sdk';
  import type { JobLine } from '@mica/shared/types';
  import JobCard from './components/JobCard.svelte';
  import LineInbox from './components/LineInbox.svelte';
  import LineThread from './components/LineThread.svelte';
  import {
    closeInbox,
    closeThread,
    inbox,
    inboxFailed,
    inboxLoaded,
    loadInbox,
    loadOlder,
    openInbox,
    openLine,
    openThread,
    openThreadId,
    refreshThread,
    reply,
    thread,
    threadCursor,
    threadLoaded,
    threadLoadingOlder
  } from './lineInbox';
  import en from './locales/en.json';
  import de from './locales/de.json';

  registerMessages('jobs', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  const { jobs, jobsLoaded, fetchJobs, setActiveJob, setDuty } = useJobs();
  const { busy, run } = useAppAction('jobs');
  const { callStore } = useCall();
  const { contactsStore: contacts } = useContacts();

  /**
   * One draft per thread, keyed by `conversation_id`, for as long as the line's inbox is open.
   * A single shared draft let a slow send clear whatever the reader had typed into the next
   * thread by the time it finished; keyed, a send clears only the draft it was sent from —
   * and only if that draft still holds what was sent. A refusal clears nothing.
   */
  let drafts = $state<Record<number, string>>({});
  /** The composer's binding: the open thread's own draft. */
  const readDraft = (): string => ($openThreadId === null ? '' : (drafts[$openThreadId] ?? ''));
  const writeDraft = (value: string): void => {
    if ($openThreadId !== null) drafts[$openThreadId] = value;
  };
  /** Bumped after the player's own reply lands, so the thread scrolls it into view. */
  let scrollRequest = $state(0);

  // Every time Jobs comes to the front, not once per session: a job can be given or taken
  // by a script while the phone is closed, and nothing but the fetch would show it. An open
  // inbox or thread re-reads too — pushes are at-most-once, the fetch is the record.
  onAppForeground('jobs', () => {
    void fetchJobs();
    void contacts.load();
    if ($openLine) void loadInbox();
    if ($openThreadId !== null) void refreshThread();
  });

  // A switch made outside the phone (a boss menu, an admin command) arrives as a push.
  // Re-read rather than patch: the payload says something changed, the server says what.
  // (`line_message` is subscribed in `lineInbox.ts`, at module scope, so it is never missed.)
  useAppEvents('jobs').on('changed', () => void fetchJobs());

  /** A saved contact's name for a caller's number, as Messages and the dialler show it. */
  const nameFor = (number: string): string => {
    const match = $contacts.find((c) => c.phone === number);
    if (!match) return number;
    return match.lastname ? `${match.firstname} ${match.lastname}` : match.firstname;
  };

  const openThreadRow = $derived(
    $openThreadId === null ? null : $inbox.find((row) => row.conversation_id === $openThreadId)
  );

  const leaveThread = () => closeThread();

  const leaveInbox = () => {
    drafts = {};
    closeInbox();
  };

  const app = useAppLevels({
    appId: 'jobs',
    title: () => {
      if ($openThreadId !== null) {
        const from = openThreadRow?.from;
        return from ? nameFor(from) : $t('jobs.unknownCaller');
      }
      if ($openLine) return $openLine.label;
      return $t('jobs.title');
    },
    onback: () => onback(),
    levels: [
      { open: () => $openThreadId !== null, close: leaveThread },
      { open: () => $openLine !== null, close: leaveInbox }
    ]
  });

  /**
   * Both setters answer a refusal as a value, so the caller can name the reason. `run`
   * toasts a throw — so a refusal becomes one here, carrying the translated reason, and
   * the toast says why rather than "that did not work". The keys stay flat and camelCase
   * like Bank's, so the reason is mapped rather than interpolated into a key.
   */
  const REFUSAL = {
    unknown_job: 'jobs.refusalUnknownJob',
    not_active: 'jobs.refusalNotActive',
    refused: 'jobs.refusalRefused',
    unsupported: 'jobs.refusalUnsupported'
  } as const;

  const orThrow = async (work: Promise<JobActionOutcome>) => {
    const outcome = await work;
    if (!outcome.ok) throw new Error($t(REFUSAL[outcome.reason]));
  };

  const switchTo = (name: string) => void run(() => orThrow(setActiveJob(name)));
  const toggleDuty = (name: string, onDuty: boolean) =>
    void run(() => orThrow(setDuty(name, onDuty)));
  const callLine = (number: string, label: string) => void callStore.startCall(number, label);
  const showInbox = (line: JobLine) => {
    drafts = {};
    openInbox(line);
  };
  const showThread = (conversationId: number) => openThread(conversationId);

  /**
   * Answer as the line. A refusal — the player went off duty mid-thread, the line was
   * withdrawn — is the server's to explain, and `run` toasts its message; the draft stays
   * so nothing typed is lost.
   */
  const send = async () => {
    const conversationId = $openThreadId;
    if (conversationId === null || $busy) return;
    const sent = drafts[conversationId] ?? '';
    const text = sent.trim();
    if (!text) return;
    if (!(await run(() => reply(conversationId, text)))) return;
    if (drafts[conversationId] === sent) delete drafts[conversationId];
    if ($openThreadId === conversationId) scrollRequest++;
  };
</script>

<Screen title={app.title} onback={app.back}>
  {#if $openLine && $openThreadId !== null}
    <div class="flex min-h-0 flex-1 flex-col">
      {#key $openThreadId}
        <LineThread
          messages={$thread}
          loaded={$threadLoaded}
          hasOlder={$threadCursor !== null}
          loadingOlder={$threadLoadingOlder}
          {scrollRequest}
          onloadolder={() => void loadOlder()}
        />
      {/key}
      <MessageBar
        bind:value={readDraft, writeDraft}
        maxlength={MESSAGE_BODY_MAX}
        busy={$busy}
        placeholder={$t('jobs.replyPlaceholder', { label: $openLine.label })}
        onsend={() => void send()}
      />
    </div>
  {:else if $openLine}
    <LineInbox
      threads={$inbox}
      loaded={$inboxLoaded}
      failed={$inboxFailed}
      {nameFor}
      onopen={showThread}
    />
  {:else}
    <div class="space-y-3 px-4 pt-4 pb-home-indicator">
      {#if !$jobsLoaded}
        <Skeleton count={3} height="h-24" />
      {:else}
        {#each $jobs as job (job.name)}
          <JobCard
            {job}
            busy={$busy}
            onswitch={switchTo}
            onduty={toggleDuty}
            oncall={callLine}
            oninbox={showInbox}
          />
        {:else}
          <EmptyState title={$t('jobs.noJobs')} description={$t('jobs.noJobsHint')} />
        {/each}
      {/if}
    </div>
  {/if}
</Screen>
