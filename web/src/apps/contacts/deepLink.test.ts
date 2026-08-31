// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Contact } from '@shared/types';

const mocks = vi.hoisted(() => ({
  openApp: vi.fn(),
  // Inside the hoisted block, not above it: `vi.mock`'s factory runs before this file's
  // own top-level statements, so a plain `const` here would be in its TDZ when the mock
  // reaches for it.
  jim: {
    id: 1,
    citizenid: 'me',
    firstname: 'Jim',
    lastname: 'Halpert',
    phone: '555-0100',
    favorite: false
  } as Contact
}));

vi.mock('@gphone/sdk', async (importOriginal) => {
  const original = await importOriginal<object>();
  const store = <T>(value: T) => ({
    subscribe: (fn: (v: T) => void) => {
      fn(value);
      return () => {};
    }
  });
  const contactsStore = Object.assign(store([mocks.jim]), { loaded: store(true) });
  return {
    ...original,
    useNavigation: () => ({ openApp: mocks.openApp }),
    useCall: () => ({ callStore: { startCall: vi.fn() } }),
    useMessages: () => ({ conversationsStore: store([]) }),
    useContacts: () => ({ contactsStore }),
    useMedia: () => ({ media: store([]) }),
    usePhoneNotification: () => ({ toast: vi.fn() }),
    useAppAction: () => ({ busy: store(false), run: vi.fn() })
  };
});

import Contacts from './index.svelte';

describe('Contacts deep link', () => {
  it('opens straight to a contact when handed one, rather than to the list', async () => {
    render(Contacts, { props: { onback: () => {}, initialContact: mocks.jim } });

    // The screen title, not the phone number — the list renders numbers too, so asserting
    // on one would pass whether or not the deep link did anything.
    expect(await screen.findByText('Contact Details')).toBeTruthy();
  });

  it('opens to the list when handed no contact', () => {
    render(Contacts, { props: { onback: () => {} } });

    expect(screen.queryByText('Contact Details')).toBeNull();
  });
});
