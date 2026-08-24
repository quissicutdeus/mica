// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Phone from './index.svelte';
import { callLog } from '../../services/callLog';
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
