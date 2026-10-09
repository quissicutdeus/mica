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
import {
  charge,
  chargeOf,
  firedBatteryWarningsOf,
  NO_BATTERY_WARNINGS_FIRED
} from './state/charge';
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

/** The phone's own warning, as `PhoneFrame` mounts it; `charge` below is the phone's too. */
const phoneWarning = { props: { device: 'phone' as const } };
const tabletWarning = { props: { device: 'tablet' as const } };
const firedBatteryWarnings = firedBatteryWarningsOf.phone;

const settle = async () => {
  await tick();
  await tick();
};

beforeEach(() => {
  chargeOf.phone.set(100);
  chargeOf.tablet.set(100);
  firedBatteryWarningsOf.phone.set(NO_BATTERY_WARNINGS_FIRED);
  firedBatteryWarningsOf.tablet.set(NO_BATTERY_WARNINGS_FIRED);
  isLocked.set(false);
  callStore.setStatus('idle');
  dndEnabled.set(false);
  for (const t of get(toast)) toast.dismiss(t.id);
});

afterEach(cleanup);

describe('BatteryWarning', () => {
  it('warns once at 20% and not again on the way down', async () => {
    render(BatteryWarning, phoneWarning);
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
    const first = render(BatteryWarning, phoneWarning);
    charge.set(18);
    await settle();
    expect(warnings()).toHaveLength(1);
    toast.dismiss(warnings()[0].id);
    first.unmount();

    render(BatteryWarning, phoneWarning);
    await settle();
    expect(warnings()).toHaveLength(0);
  });

  it('re-arms after charging and warns again on the next drain', async () => {
    render(BatteryWarning, phoneWarning);
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
    render(BatteryWarning, phoneWarning);
    charge.set(15);
    await settle();
    expect(warnings()).toHaveLength(0);
    expect(get(firedBatteryWarnings)).toEqual(NO_BATTERY_WARNINGS_FIRED);

    isLocked.set(false);
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it('holds the warning during a call and fires it once the call ends', async () => {
    render(BatteryWarning, phoneWarning);
    callStore.setIncoming('5550000', 'Caller');
    charge.set(19);
    await settle();
    expect(warnings()).toHaveLength(0);

    callStore.setStatus('idle');
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it('never fires on a dead battery', async () => {
    render(BatteryWarning, phoneWarning);
    charge.set(0);
    await settle();
    expect(warnings()).toHaveLength(0);
    expect(get(firedBatteryWarnings)).toEqual(NO_BATTERY_WARNINGS_FIRED);
  });

  it('is not silenced by Do Not Disturb', async () => {
    dndEnabled.set(true);
    render(BatteryWarning, phoneWarning);
    charge.set(5);
    await settle();
    expect(warnings()).toHaveLength(1);
  });
});

/**
 * MICA-337: the tablet has a battery of its own, so each frame's warning reads its own
 * device's charge and spends its own device's flags.
 */
describe('BatteryWarning per device', () => {
  it("does not warn on the phone for the tablet's drain, nor spend the phone's warning", async () => {
    render(BatteryWarning, phoneWarning);
    chargeOf.tablet.set(10);
    await settle();
    expect(warnings()).toHaveLength(0);
    expect(get(firedBatteryWarningsOf.phone)).toEqual(NO_BATTERY_WARNINGS_FIRED);
    expect(get(firedBatteryWarningsOf.tablet)).toEqual(NO_BATTERY_WARNINGS_FIRED);

    chargeOf.phone.set(18);
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it("warns once for each device's own drain", async () => {
    const tablet = render(BatteryWarning, tabletWarning);
    chargeOf.tablet.set(18);
    chargeOf.phone.set(18);
    await settle();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toContain('18%');
    expect(get(firedBatteryWarningsOf.tablet)).toEqual({ 20: true, 5: false });
    expect(get(firedBatteryWarningsOf.phone)).toEqual(NO_BATTERY_WARNINGS_FIRED);
    toast.dismiss(warnings()[0].id);
    tablet.unmount();

    // The phone's own threshold was never spent by the tablet's warning.
    render(BatteryWarning, phoneWarning);
    await settle();
    expect(warnings()).toHaveLength(1);
    expect(get(firedBatteryWarningsOf.phone)).toEqual({ 20: true, 5: false });
  });

  it("holds a device's warning until its own frame is up", async () => {
    chargeOf.tablet.set(15);
    render(BatteryWarning, phoneWarning);
    await settle();
    expect(warnings()).toHaveLength(0);

    render(BatteryWarning, tabletWarning);
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it('never warns over the lock screen on the tablet either', async () => {
    isLocked.set(true);
    render(BatteryWarning, tabletWarning);
    chargeOf.tablet.set(5);
    await settle();
    expect(warnings()).toHaveLength(0);

    isLocked.set(false);
    await settle();
    expect(warnings()).toHaveLength(1);
  });

  it("is quiet on a dead tablet while the phone's warning still fires", async () => {
    render(BatteryWarning, tabletWarning);
    render(BatteryWarning, phoneWarning);
    chargeOf.tablet.set(0);
    chargeOf.phone.set(19);
    await settle();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toContain('19%');
  });
});
