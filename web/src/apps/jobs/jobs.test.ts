// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { renderApp } from '@mica/sdk/testing';
import type { JobActionOutcome, JobView } from '@mica/shared/types';

/**
 * The transport, keyed on the contracted action the way the browser mock is. Every
 * `call()` here rides the generic `svc` action with `{ service, action, data }`, so a
 * per-action table is enough to stand in for the server, and each test says exactly
 * what the server answers.
 */
const answers = new Map<string, (data: unknown) => unknown>();
const fetchNui = vi.fn(async (_action: string, payload?: { action?: string; data?: unknown }) => {
  const handler = answers.get(payload?.action ?? '');
  return handler ? handler(payload?.data) : null;
});

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: (...args: unknown[]) => fetchNui(...(args as [string, never])),
  isBrowser: () => true
}));

import Jobs from './index.svelte';
import manifest from './manifest';
import { jobs, jobsLoaded } from '../../services/jobs';

const job = (over: Partial<JobView> & Pick<JobView, 'name' | 'label'>): JobView => ({
  grade: 0,
  gradeLabel: 'Grade',
  salary: 100,
  onDuty: false,
  isBoss: false,
  active: false,
  lines: [],
  societyBalance: null,
  ...over
});

const three = (): JobView[] => [
  job({
    name: 'police',
    label: 'LSPD',
    grade: 2,
    gradeLabel: 'Sergeant',
    onDuty: true,
    active: true
  }),
  job({
    name: 'mechanic',
    label: 'Los Santos Customs',
    grade: 3,
    gradeLabel: 'Owner',
    isBoss: true,
    societyBalance: 48200,
    lines: [{ number: '555-0142', label: 'LSC Front Desk' }]
  }),
  job({ name: 'taxi', label: 'Downtown Cab Co.', gradeLabel: 'Driver', onDuty: null })
];

/** `renderApp` with the manifest's own permissions, so a hook the manifest forgot throws here. */
const render = () => renderApp(Jobs, { id: 'jobs', permissions: manifest.permissions });

beforeEach(() => {
  answers.clear();
  fetchNui.mockClear();
  // Module-scoped, so they survive between tests: without the reset the second test
  // inherits the first one's completed fetch and never sees the loading frame.
  jobs.set([]);
  jobsLoaded.set(false);
});

describe('Jobs', () => {
  it('shows a placeholder rather than the empty state while the fetch is in flight', () => {
    answers.set('getJobs', () => new Promise(() => {}));
    const { queryByText, getByText } = render();
    expect(queryByText('No jobs')).toBeNull();
    expect(getByText('Loading')).toBeTruthy();
  });

  it('says so when the player holds no jobs', async () => {
    answers.set('getJobs', () => []);
    const { findByText } = render();
    expect(await findByText('No jobs')).toBeTruthy();
  });

  it('lists every job and marks the active one', async () => {
    answers.set('getJobs', () => three());
    const { findByText, getAllByTestId } = render();
    expect(await findByText('LSPD')).toBeTruthy();
    expect(screen.getByText('Los Santos Customs')).toBeTruthy();
    expect(screen.getByText('Downtown Cab Co.')).toBeTruthy();
    expect(screen.getByText('Grade 2 · Sergeant')).toBeTruthy();

    const cards = getAllByTestId('job-card');
    expect(cards.map((c) => c.dataset.active)).toEqual(['true', 'false', 'false']);
    expect(screen.getAllByText('Active')).toHaveLength(1);
  });

  it('switches through the service when a non-active card is tapped, and the list follows the reply', async () => {
    answers.set('getJobs', () => three());
    answers.set('setActiveJob', (data): JobActionOutcome => {
      const next = three().map((j) => ({
        ...j,
        active: j.name === (data as { name: string }).name
      }));
      return { ok: true, jobs: next };
    });
    const { findByText, getAllByTestId } = render();
    await findByText('LSPD');

    await fireEvent.click(screen.getByText('Los Santos Customs'));

    await waitFor(() => {
      expect(getAllByTestId('job-card').map((c) => c.dataset.active)).toEqual([
        'false',
        'true',
        'false'
      ]);
    });
    expect(fetchNui).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({
        service: 'jobs',
        action: 'setActiveJob',
        data: { name: 'mechanic' }
      })
    );
    expect(get(jobs).find((j) => j.active)?.name).toBe('mechanic');
  });

  it('does not ask the server when the active card is tapped', async () => {
    answers.set('getJobs', () => three());
    const { findByText } = render();
    await findByText('LSPD');

    await fireEvent.click(screen.getByText('LSPD'));

    expect(fetchNui.mock.calls.some((c) => c[1]?.action === 'setActiveJob')).toBe(false);
  });

  it('offers the duty switch only where the framework has one, and only enabled on the active job', async () => {
    answers.set('getJobs', () => three());
    const { findByText, container } = render();
    await findByText('LSPD');

    const switches = container.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    // `taxi` has `onDuty: null` — no switch at all, not a disabled one.
    expect(switches).toHaveLength(2);
    const [police, mechanic] = Array.from(switches);
    expect(police.disabled).toBe(false);
    expect(police.getAttribute('aria-checked')).toBe('true');
    expect(mechanic.disabled).toBe(true);
  });

  it('toggles duty on the active job through the service', async () => {
    answers.set('getJobs', () => three());
    answers.set('setDuty', (data): JobActionOutcome => {
      const { onDuty } = data as { name: string; onDuty: boolean };
      return { ok: true, jobs: three().map((j) => (j.active ? { ...j, onDuty } : j)) };
    });
    const { findByText, container } = render();
    await findByText('LSPD');

    const police = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await fireEvent.click(police);

    await waitFor(() => expect(police.getAttribute('aria-checked')).toBe('false'));
    // Both cards now read "Off duty": the mechanic's did already, the police one followed
    // the server's re-read list — which is what the text assertion is about.
    expect(screen.getAllByText('Off duty')).toHaveLength(2);
    expect(fetchNui).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({ action: 'setDuty', data: { name: 'police', onDuty: false } })
    );
  });

  it('shows the society balance only for a boss', async () => {
    answers.set('getJobs', () => three());
    const { findByText } = render();
    await findByText('LSPD');

    expect(screen.getAllByText('Society balance')).toHaveLength(1);
    expect(screen.getByText('$48,200.00')).toBeTruthy();
  });

  it('renders a registered line with its label and number', async () => {
    answers.set('getJobs', () => three());
    const { findByText } = render();
    expect(await findByText('LSC Front Desk')).toBeTruthy();
    expect(screen.getByText('555-0142')).toBeTruthy();
  });
});
