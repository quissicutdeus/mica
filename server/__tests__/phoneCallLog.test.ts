// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { declaredServices } from '../lib/defineService';
import '../services/PhoneCallLog';

describe('PhoneCallLog service declaration', () => {
  const resolved = declaredServices.find((s) => s.id === 'phone_call_log');

  it('registers a service named phone_call_log backed by mica_phone_call_log', () => {
    expect(resolved).toBeDefined();
    expect(resolved?.table).toBe('mica_phone_call_log');
  });

  it('declares kind, number and duration as columns', () => {
    expect(resolved?.columns).toEqual(expect.arrayContaining(['kind', 'number', 'duration']));
  });

  it('makes no column client-writable — the server is the only writer', () => {
    expect(resolved?.clientWritable).toEqual([]);
  });

  it('scopes reads to the owner, not public', () => {
    expect(resolved?.access.read).toBe('owner');
  });

  it('declares paging, so the generic read is guaranteed newest-first order', () => {
    expect(resolved?.paging).not.toBeNull();
  });
});
