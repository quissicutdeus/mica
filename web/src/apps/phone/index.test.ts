// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent } from '@testing-library/svelte';

// The app reaches `loadCallLog` through `useCall()`, which resolves to this same module,
// so mocking it here covers the SDK facet too.
const loadCallLogSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../services/callLog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCallLog: loadCallLogSpy
}));

import Phone from './index.svelte';
import { callLog } from '../../services/callLog';
import { callStore } from '../../services/call';
import { contacts } from '../../services/contacts';

// jsdom has no Web Animations API and some SDK transitions call it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

describe('Phone Recents tab', () => {
  beforeEach(() => {
    callLog.set([]);
    contacts.set([]);
    callStore.setStatus('idle');
    loadCallLogSpy.mockClear();
  });

  it('defaults to the Keypad tab', () => {
    const { getByText, queryByText } = render(Phone, { props: { onback: () => {} } });
    expect(getByText('9')).toBeTruthy(); // dialpad digit, only in Keypad
    expect(queryByText('No recent calls')).toBeNull();
  });

  it('switching to Recents shows an empty state with no calls', async () => {
    const { getByText } = render(Phone, { props: { onback: () => {} } });
    await fireEvent.click(getByText('Recents'));
    expect(getByText('No recent calls')).toBeTruthy();
  });

  it('shows a missed call without a duration, and an answered call with one', async () => {
    callLog.set([
      { id: 2, citizenid: 'CID', kind: 'missed', number: '555-0200', duration: 0 },
      { id: 1, citizenid: 'CID', kind: 'outgoing', number: '555-0100', duration: 65 }
    ] as never);

    const { getByText } = render(Phone, { props: { onback: () => {} } });
    await fireEvent.click(getByText('Recents'));

    expect(getByText('555-0200')).toBeTruthy();
    expect(getByText('555-0100')).toBeTruthy();
    expect(getByText('1:05')).toBeTruthy();
  });

  it('resolves a contact name instead of the raw number when one matches', async () => {
    contacts.set([
      {
        id: 1,
        citizenid: 'CID',
        firstname: 'Ada',
        lastname: 'Lovelace',
        phone: '555-0100',
        favorite: false
      }
    ] as never);
    callLog.set([
      { id: 1, citizenid: 'CID', kind: 'outgoing', number: '555-0100', duration: 10 }
    ] as never);

    const { getByText } = render(Phone, { props: { onback: () => {} } });
    await fireEvent.click(getByText('Recents'));

    expect(getByText('Ada Lovelace')).toBeTruthy();
  });
});

describe('Phone Recents refresh', () => {
  beforeEach(() => {
    callLog.set([]);
    contacts.set([]);
    callStore.setStatus('idle');
    loadCallLogSpy.mockClear();
  });

  it('does not refetch on a plain mount, which is already idle', async () => {
    render(Phone, { props: { onback: () => {} } });
    await tick();

    expect(loadCallLogSpy).not.toHaveBeenCalled();
  });

  it('refetches when a call ends, including when the server ends it (MICA-95)', async () => {
    render(Phone, { props: { onback: () => {} } });
    await tick();
    loadCallLogSpy.mockClear();

    // The peer hanging up, a decline, and an unreachable number all reach the store as a
    // `callStatus: idle` push rather than through the hang-up button, and used to refresh
    // nothing — the row the server had just written stayed invisible until the app was
    // backgrounded and reopened.
    callStore.setIncoming('555-0100');
    await tick();
    callStore.setStatus('idle');
    await tick();

    expect(loadCallLogSpy).toHaveBeenCalledTimes(1);
  });
});
