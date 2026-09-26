// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { tick } from 'svelte';
import { render } from '@testing-library/svelte';
import Status from './Status.svelte';
import { charge } from '../state/charge';
import { setSignal } from '../state/signal';
import { airplaneModeEnabled } from '../state/airplane';

/** MICA-245: the Status widget reads the stores the status bar reads. */

beforeEach(() => {
  charge.set(80);
  setSignal(3);
  airplaneModeEnabled.set(false);
});

describe('Status widget', () => {
  it.each(['2x1', '2x2'] as const)('shows battery and signal at %s', (size) => {
    const { getByTestId, getByLabelText } = render(Status, { size });
    expect(getByTestId('widget-status-battery').textContent).toBe('80%');
    expect(getByLabelText('Battery 80%')).toBeTruthy();
    expect(getByLabelText('Signal 3 of 4 bars')).toBeTruthy();
  });

  it('updates from the stores and flags low battery as an error', async () => {
    const { getByTestId, getByLabelText } = render(Status, { size: '2x2' });
    charge.set(15);
    setSignal(0);
    await tick();
    const level = getByTestId('widget-status-battery');
    expect(level.textContent).toBe('15%');
    expect(level.classList.contains('text-error')).toBe(true);
    expect(getByLabelText('No signal')).toBeTruthy();
  });

  it('says airplane mode instead of a signal', async () => {
    airplaneModeEnabled.set(true);
    const { getByLabelText } = render(Status, { size: '2x1' });
    expect(getByLabelText('Airplane mode')).toBeTruthy();
  });
});
