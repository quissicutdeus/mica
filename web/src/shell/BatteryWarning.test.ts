// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against — in-process, because a
 * unit test stands in for the shell.
 */
import '../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup } from '@testing-library/svelte';
import { get } from 'svelte/store';
import BatteryWarning from './BatteryWarning.svelte';
import { charge, firedBatteryWarnings, NO_BATTERY_WARNINGS_FIRED } from './state/charge';
import { isLocked } from './state/lockScreen';
import { callStore } from '../services/call';
import { toast } from './state/toast';
import { dndEnabled } from './state/notificationPolicy';

/**
 * MICA-193. The reducer's cases are in `state/charge.test.ts`; what is held down here is
 * the wiring around it — that the component reads the right gates, writes the shared
 * flags, and turns a due threshold into exactly one warning toast.
 */

const warnings = () => get(toast).filter((t) => t.title === 'Battery Low');

const settle = async () => {
  await tick();
  await tick();
};

beforeEach(() => {
  charge.set(100);
  firedBatteryWarnings.set(NO_BATTERY_WARNINGS_FIRED);
  isLocked.set(false);
  callStore.setStatus('idle');
  dndEnabled.set(false);
  for (const t of get(toast)) toast.dismiss(t.id);
});

afterEach(cleanup);

describe('BatteryWarning', () => {
  it('warns once at 20% and not again on the way down', async () => {
    render(BatteryWarning);
    charge.set(20);
    await settle();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].type).toBe('warning');
    expect(get(firedBatteryWarnings)).toEqual({ 20: true, 5: false });

    toast.dismiss(warnings()[0].id);
    charge.set(12);
    await settle();
    expect(warnings()).toHaveLength(0);
  });

  it('does not re-warn when the frame remounts at the same level', async () => {
    const first = render(BatteryWarning);
    charge.set(18);
    await settle();
    expect(warnings()).toHaveLength(1);
    toast.dismiss(warnings()[0].id);
    first.unmount();

    render(BatteryWarning);
    await settle();
    expect(warnings()).toHaveLength(0);
  });

  it('re-arms after charging and warns again on the next drain', async () => {
    render(BatteryWarning);
    charge.set(20);
    await settle();
    toast.dismiss(warnings()[0].id);

    charge.set(60);
    await settle();
    expect(get(firedBatteryWarnings)).toEqual(NO_BATTERY_WARNINGS_FIRED);

    charge.set(20);
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it('holds the warning while locked and fires it on unlock', async () => {
    isLocked.set(true);
    render(BatteryWarning);
    charge.set(15);
    await settle();
    expect(warnings()).toHaveLength(0);
    expect(get(firedBatteryWarnings)).toEqual(NO_BATTERY_WARNINGS_FIRED);

    isLocked.set(false);
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it('holds the warning during a call and fires it once the call ends', async () => {
    render(BatteryWarning);
    callStore.setIncoming('5550000', 'Caller');
    charge.set(19);
    await settle();
    expect(warnings()).toHaveLength(0);

    callStore.setStatus('idle');
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it('never fires on a dead battery', async () => {
    render(BatteryWarning);
    charge.set(0);
    await settle();
    expect(warnings()).toHaveLength(0);
    expect(get(firedBatteryWarnings)).toEqual(NO_BATTERY_WARNINGS_FIRED);
  });

  it('is not silenced by Do Not Disturb', async () => {
    dndEnabled.set(true);
    render(BatteryWarning);
    charge.set(5);
    await settle();
    expect(warnings()).toHaveLength(1);
  });
});
