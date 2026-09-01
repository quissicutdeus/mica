// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { setClientTransport, type ClientTransport } from '../transport';
import type { ToShell, ToFrame } from '../messages';

// MICA-16 step 4: shared by remote.test.ts and dataFacets.test.ts — a transport whose
// "shell" is the test: records sends, lets the test answer.
export function fakeTransport() {
  const sent: ToShell[] = [];
  const replies = new Map<number, (m: Extract<ToFrame, { kind: 'reply' }>) => void>();
  const pushes = new Map<number, (v: unknown) => void>();
  const callbacks = new Map<number, (...a: unknown[]) => unknown>();
  let nextCb = 1;
  const t: ClientTransport = {
    send: (m) => sent.push(m),
    hydrated: () => Promise.reject(new Error('not in this test')),
    onReply: (id, cb) => replies.set(id, cb),
    onPush: (id, cb) => {
      pushes.set(id, cb);
      return () => pushes.delete(id);
    },
    registerCallback: (fn) => {
      const id = nextCb++;
      callbacks.set(id, fn);
      return id;
    },
    releaseCallback: (fn) => {
      for (const [id, registered] of callbacks) {
        if (registered === fn) {
          callbacks.delete(id);
          return;
        }
      }
    },
    onTheme: () => {},
    onStorage: () => {},
    onProps: () => {}
  };
  setClientTransport(t);
  return { sent, replies, pushes, callbacks };
}
