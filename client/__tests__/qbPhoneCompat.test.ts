// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** qb-phone's client notification becomes the shell's toast (MICA-222). */
// Hoisted so the capture is installed before the module under test registers -- imports
// run first, whatever order they are written in.
const { handlers, sent } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const g = globalThis as Record<string, unknown>;
  const previousOnNet = g.onNet;
  g.onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousOnNet === 'function' ? previousOnNet(event, handler) : undefined;
  };
  const messages: { action: string; data: any }[] = [];
  g.SendNuiMessage = (payload: string) => messages.push(JSON.parse(payload));
  return { handlers: captured, sent: messages };
});

import '../services/QbPhoneCompat';
import { QB_PHONE_CLIENT_EVENTS } from '@mica/shared/qbPhoneEvents';

const fire = (...args: unknown[]) =>
  handlers.get(QB_PHONE_CLIENT_EVENTS.customNotification)!(...args);

beforeEach(() => {
  sent.length = 0;
});

describe('qb-phone:client:CustomNotification', () => {
  it('is registered as a net event, the way qb scripts fire it from the server', () => {
    expect(handlers.has(QB_PHONE_CLIENT_EVENTS.customNotification)).toBe(true);
  });

  it("carries qb's title and text into the shell's toast and drops the rest", () => {
    fire('Los Santos Customs', 'Your car is ready.', 'fas fa-car', '#ff0000', 5000);
    expect(sent).toEqual([
      {
        action: 'notify',
        data: { type: 'info', title: 'Los Santos Customs', message: 'Your car is ready.' }
      }
    ]);
  });

  it('shows a title alone as the message, and nothing when there is nothing to read', () => {
    fire('Just a title');
    expect(sent[0].data).toEqual({ type: 'info', title: 'Just a title', message: 'Just a title' });
    fire(undefined, 42);
    fire('   ', '');
    expect(sent).toHaveLength(1);
  });
});
