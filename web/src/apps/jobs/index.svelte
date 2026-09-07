<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    EmptyState,
    Screen,
    Skeleton,
    onAppForeground,
    registerMessages,
    useAppAction,
    useAppEvents,
    useCall,
    useJobs,
    useLocale,
    type AppProps,
    type JobActionOutcome
  } from '@mica/sdk';
  import JobCard from './components/JobCard.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  registerMessages('jobs', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  const { jobs, jobsLoaded, fetchJobs, setActiveJob, setDuty } = useJobs();
  const { busy, run } = useAppAction('jobs');
  const { callStore } = useCall();

  // Every time Jobs comes to the front, not once per session: a job can be given or taken
  // by a script while the phone is closed, and nothing but the fetch would show it.
  onAppForeground('jobs', () => void fetchJobs());

  // A switch made outside the phone (a boss menu, an admin command) arrives as a push.
  // Re-read rather than patch: the payload says something changed, the server says what.
  useAppEvents('jobs').on('changed', () => void fetchJobs());

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
</script>

<Screen title={$t('jobs.title')} {onback}>
  <div class="space-y-3 px-4 pt-4 pb-home-indicator">
    {#if !$jobsLoaded}
      <Skeleton count={3} height="h-24" />
    {:else}
      {#each $jobs as job (job.name)}
        <JobCard {job} busy={$busy} onswitch={switchTo} onduty={toggleDuty} oncall={callLine} />
      {:else}
        <EmptyState title={$t('jobs.noJobs')} description={$t('jobs.noJobsHint')} />
      {/each}
    {/if}
  </div>
</Screen>
