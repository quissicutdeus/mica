import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('../nui/fetchNui', () => ({ fetchNui: vi.fn(async () => ({})) }));

import { createNuiMessageRouter } from './nuiMessages';
import { toast } from './state/toast';
import { time } from './state/time';
import { charge } from './state/charge';
import { signalLevel } from './state/signal';
import { contacts } from '../services/contacts';
import { appRegistryStore } from './state/registry';

/**
 * These twelve branches previously lived inside `App.svelte` and had no unit tests at
 * all — a handful of e2e specs touched three of them. The contact-share path in
 * particular does real validation, and a share arriving with no name or number would
 * otherwise be written as a blank contact.
 */

const message = (action: string, data?: unknown) => ({ data: { action, data } }) as MessageEvent;

let opened: { app: string; props?: Record<string, unknown> }[] = [];
const route = createNuiMessageRouter({
  openFromNotification: (app, props) => opened.push({ app, props })
});

/** The most recent toast, whatever kind. */
const lastToast = () => get(toast)[0];

beforeEach(() => {
  opened = [];
  toast.clear();
  vi.restoreAllMocks();
});

describe('routing', () => {
  it('reports whether it consumed the message', () => {
    // The shell relies on this to know what is left for it to handle.
    expect(route(message('setTime', { hours: 1, minutes: 2 }))).toBe(true);
    expect(route(message('setVisible', true))).toBe(false);
    expect(route(message('callStatus', { status: 'idle' }))).toBe(false);
  });

  it('survives a malformed message', () => {
    expect(() => route({ data: undefined } as MessageEvent)).not.toThrow();
    expect(route({ data: {} } as MessageEvent)).toBe(false);
    expect(route(message('somethingElse'))).toBe(false);
  });
});

describe('hardware state', () => {
  it('sets the clock', () => {
    route(message('setTime', { hours: 9, minutes: 30 }));
    expect(get(time)).toEqual({ hours: 9, minutes: 30 });
  });

  it('ignores a non-numeric charge or signal', () => {
    charge.set(50);
    signalLevel.set(3);

    route(message('setCharge', 'nonsense'));
    route(message('setSignal', null));

    expect(get(charge)).toBe(50);
    expect(get(signalLevel)).toBe(3);
  });

  it('accepts numeric ones', () => {
    route(message('setCharge', 12));
    route(message('setSignal', 1));
    expect(get(charge)).toBe(12);
    expect(get(signalLevel)).toBe(1);
  });
});

describe('notify', () => {
  it('shows a server-originated toast', () => {
    route(message('notify', { type: 'error', title: 'Denied', message: 'No permission' }));
    expect(lastToast()).toMatchObject({ type: 'error', message: 'No permission' });
  });

  it('defaults the type', () => {
    route(message('notify', { message: 'Plain' }));
    expect(lastToast()).toMatchObject({ type: 'info' });
  });

  it('ignores an empty or missing message', () => {
    route(message('notify', { message: '' }));
    route(message('notify', {}));
    route(message('notify', { message: 42 }));
    expect(get(toast)).toHaveLength(0);
  });
});

describe('notification click-through', () => {
  it('opens Mail on the message that arrived', () => {
    route(message('receiveMail', { id: 7, sender: 'a@b.c', subject: 'Hi' }));
    lastToast()?.onClick?.();
    expect(opened).toEqual([{ app: 'mail', props: { mailId: 7 } }]);
  });

  it('opens the conversation a message belongs to', () => {
    route(message('receiveMessage', { conversation_id: 3, phone: '555', message: 'yo' }));
    lastToast()?.onClick?.();
    expect(opened).toEqual([{ app: 'messages', props: { conversationId: 3, phone: '555' } }]);
  });

  it('falls back to senderPhone when phone is absent', () => {
    route(message('receiveMessage', { conversation_id: 4, senderPhone: '999' }));
    lastToast()?.onClick?.();
    expect(opened[0].props).toMatchObject({ phone: '999' });
  });
});

describe('installApp', () => {
  it('rejects a data: URL before it ever reaches loadRemoteApp', () => {
    const loadRemoteApp = vi.spyOn(appRegistryStore, 'loadRemoteApp');

    route(message('installApp', { url: 'data:text/javascript,alert(1)' }));

    expect(loadRemoteApp).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({
      type: 'error',
      message: expect.stringContaining('data:')
    });
  });

  it('still forwards a normal https URL to loadRemoteApp', () => {
    const loadRemoteApp = vi
      .spyOn(appRegistryStore, 'loadRemoteApp')
      .mockRejectedValue(new Error('not trusted'));

    route(message('installApp', { url: 'https://example.com/app.js' }));

    expect(loadRemoteApp).toHaveBeenCalledWith('https://example.com/app.js');
  });
});

describe('contact share', () => {
  const accept = async () => {
    const actions = lastToast()?.actions ?? [];
    await actions.find((a: { label: string }) => a.label === 'Accept')?.onClick();
  };

  it('adds a valid contact', async () => {
    const add = vi.spyOn(contacts, 'add').mockResolvedValue(undefined as never);
    route(message('shareContact', { firstname: 'Franklin', lastname: 'C', phone: '555-0177' }));
    await accept();

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ firstname: 'Franklin', phone: '555-0177' })
    );
  });

  it('refuses a share with no name or number, rather than writing a blank contact', async () => {
    const add = vi.spyOn(contacts, 'add').mockResolvedValue(undefined as never);

    route(message('shareContact', { lastname: 'Clinton' }));
    await accept();
    expect(add).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ type: 'error' });

    route(message('shareContact', { firstname: '   ', phone: '  ' }));
    await accept();
    expect(add).not.toHaveBeenCalled();
  });

  it('trims whitespace off the fields it keeps', async () => {
    const add = vi.spyOn(contacts, 'add').mockResolvedValue(undefined as never);
    route(message('shareContact', { firstname: '  Frank  ', phone: ' 555 ', lastname: ' C ' }));
    await accept();

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ firstname: 'Frank', phone: '555', lastname: 'C' })
    );
  });

  it('surfaces a failure instead of claiming success', async () => {
    vi.spyOn(contacts, 'add').mockRejectedValue(new Error('duplicate'));
    route(message('shareContact', { firstname: 'A', phone: '1' }));
    await accept();

    expect(lastToast()).toMatchObject({ type: 'error', message: 'duplicate' });
  });

  it('answers to both names the client has used', () => {
    expect(route(message('shareContact', { firstname: 'A', phone: '1' }))).toBe(true);
    expect(route(message('receiveContactShare', { firstname: 'A', phone: '1' }))).toBe(true);
  });
});
