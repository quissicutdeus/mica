<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { ChevronRightIcon, ListItem, ToggleSwitch, formatCurrency, useLocale } from '@mica/sdk';
  import type { JobView } from '@mica/sdk';
  import type { JobLine } from '@mica/shared/types';

  /**
   * One held job.
   *
   * The head of the card is a `<button>` so that tapping the job's name is what
   * switches to it, and it is disabled on the active card — there is nothing to switch
   * to. The duty switch, the society line and the lines a script registered under this
   * job sit below it, outside the button, because a control inside a button is invalid
   * and behaves unpredictably (`ListItem` says the same).
   *
   * Nothing here decides whether a change is allowed. The server answers with a reason
   * and the app toasts it; this component only shows what the framework said.
   */
  let {
    job,
    busy = false,
    onswitch,
    onduty,
    oncall,
    oninbox
  }: {
    job: JobView;
    /** True while any change is in flight, so a second tap cannot race the first. */
    busy?: boolean;
    onswitch: (name: string) => void;
    onduty: (name: string, onDuty: boolean) => void;
    oncall: (number: string, label: string) => void;
    /** Open a line's shared inbox — offered only on a line whose `inbox` is true. */
    oninbox: (line: JobLine) => void;
  } = $props();

  const { t } = useLocale();
</script>

<div
  class="bg-surface-container rounded-box border-2 {job.active
    ? 'border-primary'
    : 'border-transparent'}"
  data-testid="job-card"
  data-job={job.name}
  data-active={job.active}
>
  <button
    type="button"
    class="hover:bg-surface-hover active:bg-surface-pressed disabled:opacity-50 rounded-box flex w-full items-center p-4 text-left transition-colors"
    disabled={job.active || busy}
    aria-pressed={job.active}
    onclick={() => onswitch(job.name)}
  >
    <div class="min-w-0 flex-1">
      <div class="text-title-medium truncate">{job.label}</div>
      <div class="text-on-surface-variant text-body-small">
        {$t('jobs.grade', { grade: job.grade, label: job.gradeLabel })}
      </div>
      <div class="text-on-surface-variant text-body-small">
        {$t('jobs.salary', { salary: formatCurrency(job.salary) })}
      </div>
    </div>
    {#if job.active}
      <span
        class="bg-primary-container text-on-primary-container text-label-small ml-2 shrink-0 rounded-full px-2 py-1"
      >
        {$t('jobs.active')}
      </span>
    {/if}
  </button>

  {#if job.onDuty !== null}
    <div class="border-outline-variant border-t px-4 py-2">
      <!-- Only the active job can clock in or out; the server says `not_active` to any
           other, so the switch is disabled rather than letting a tap end in a toast. -->
      <ToggleSwitch
        checked={job.onDuty}
        disabled={!job.active || busy}
        label={job.onDuty ? $t('jobs.onDuty') : $t('jobs.offDuty')}
        description={job.active ? undefined : $t('jobs.dutyNeedsActive')}
        id={`duty-${job.name}`}
        onchange={(next: boolean) => onduty(job.name, next)}
      />
    </div>
  {/if}

  {#if job.societyBalance !== null}
    <div class="border-outline-variant flex items-center justify-between border-t px-4 py-3">
      <span class="text-on-surface-variant text-body-small">{$t('jobs.societyBalance')}</span>
      <span class="font-medium">${formatCurrency(job.societyBalance)}</span>
    </div>
  {/if}

  {#if job.lines.length > 0}
    <div class="border-outline-variant divide-outline-variant divide-y border-t">
      {#each job.lines as line (line.number)}
        {#if line.inbox}
          <!-- A line this player answers for (MICA-307): two sibling controls in a plain row,
               one opening the line's shared inbox and one calling it. Not a `ListItem`: that is
               `role="button"`, and a button holding the Call button is `nested-interactive`
               (axe) — a screen reader announces one control and swallows the other. -->
          <div class="flex items-center" data-testid="job-line" data-inbox="true">
            <button
              type="button"
              class="hover:bg-surface-hover active:bg-surface-pressed duration-short ease-standard flex min-w-0 flex-1 items-center p-4 text-left transition-colors"
              onclick={() => oninbox(line)}
            >
              <div class="min-w-0 flex-1">
                <div class="font-medium truncate">{line.label}</div>
                <div class="text-on-surface-variant text-body-small">
                  {$t('jobs.lineInbox', { number: line.number })}
                </div>
              </div>
              <ChevronRightIcon class="text-on-surface-variant size-icon-sm ml-1 shrink-0" />
            </button>
            <button
              type="button"
              class="text-primary text-label-large hover:bg-surface-container-high mr-3 shrink-0 rounded-full px-3 py-1 transition-colors"
              onclick={() => oncall(line.number, line.label)}
            >
              {$t('jobs.call')}
            </button>
          </div>
        {:else}
          <ListItem onclick={() => oncall(line.number, line.label)}>
            <div class="min-w-0 flex-1" data-testid="job-line" data-inbox="false">
              <div class="font-medium truncate">{line.label}</div>
              <div class="text-on-surface-variant text-body-small">{line.number}</div>
            </div>
            <span class="text-primary text-label-large ml-2 shrink-0">{$t('jobs.call')}</span>
          </ListItem>
        {/if}
      {/each}
    </div>
  {/if}
</div>
