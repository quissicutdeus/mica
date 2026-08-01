import { debugData } from '../utils/debug';

/**
 * Browser-only scaffolding: seed the phone, and expose a console helper for firing
 * notifications by hand.
 *
 * Lived inline in `App.svelte` and was roughly eighty of its lines, none of which the
 * shell needs in order to work. It also drives everything through `window.postMessage`
 * — the same path the client uses — so it exercises the real router rather than a
 * parallel one, and belongs next to it.
 */

type TestToast = 'message' | 'contact' | 'call' | 'email';

const FIXTURES: Record<TestToast, { action: string; data: unknown }> = {
  message: {
    action: 'receiveMessage',
    data: {
      conversation_id: 1,
      senderName: 'Ursula (Crazy Ex)',
      message: '1... 🤬😡🗯️‼️',
      phone: '555-0199',
      avatar:
        'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80'
    }
  },
  contact: {
    action: 'shareContact',
    data: { firstname: 'Franklin', lastname: 'Clinton', phone: '555-0177' }
  },
  call: {
    action: 'callStatus',
    data: { status: 'incoming', name: 'Lester Crest', number: '555-0155' }
  },
  email: {
    action: 'receiveMail',
    data: { sender: 'Fleeca Bank', subject: 'Your Monthly Account Statement is Ready' }
  }
};

/** Seed the phone so a browser session starts with something on screen. */
export function seedBrowserPhone(now: Date): void {
  debugData([
    { action: 'setVisible', data: true },
    { action: 'setTime', data: { hours: now.getHours(), minutes: now.getMinutes() } }
  ]);
}

/** `window.triggerTestToast('call')` from the console. Dev builds only. */
export function installDevHarness(): void {
  if (!import.meta.env.DEV) return;

  (window as any).triggerTestToast = (type: TestToast = 'message') => {
    const fixture = FIXTURES[type];
    if (!fixture) return;
    window.postMessage(fixture, '*');
  };
}
