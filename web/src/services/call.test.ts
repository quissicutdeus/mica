// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callStore } from './call';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

describe('callStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts call with dialing status and resets duration', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);

    await callStore.startCall('555-1234', 'John Doe');
    const state = get(callStore);

    expect(state.status).toBe('dialing');
    expect(state.number).toBe('555-1234');
    expect(state.name).toBe('John Doe');
    expect(state.duration).toBe(0);
  });

  it('sets incoming call status correctly', () => {
    callStore.setIncoming('555-9999', 'Jane Smith');
    const state = get(callStore);

    expect(state.status).toBe('incoming');
    expect(state.number).toBe('555-9999');
    expect(state.name).toBe('Jane Smith');
  });

  it('answers call and changes status to connected', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);

    await callStore.answerCall();
    const state = get(callStore);

    expect(state.status).toBe('connected');
  });

  it('ends call and resets to initial state', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);

    await callStore.endCall();
    const state = get(callStore);

    expect(state.status).toBe('idle');
    expect(state.number).toBe('');
    expect(state.duration).toBe(0);
  });

  describe('speaker (MICA-246)', () => {
    beforeEach(() => {
      callStore.setStatus('idle');
    });

    it('is unavailable until a connected call says otherwise', () => {
      expect(get(callStore).speakerAvailable).toBe(false);
      callStore.setStatus('connected', false);
      expect(get(callStore).speakerAvailable).toBe(false);
      callStore.setStatus('connected', true);
      expect(get(callStore).speakerAvailable).toBe(true);
    });

    it('asks the server through the phone contract and shows its answer', async () => {
      callStore.setStatus('connected', true);
      const nui = vi
        .spyOn(fetchNuiModule, 'fetchNui')
        .mockResolvedValue({ ok: true, enabled: true });

      await callStore.toggleSpeaker();

      expect(nui).toHaveBeenCalledWith('svc', {
        service: 'phone',
        action: 'speaker',
        data: { enabled: true }
      });
      expect(get(callStore).speaker).toBe(true);
    });

    it('shows a refusal as off, whatever it asked for', async () => {
      callStore.setStatus('connected', true);
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ ok: false, enabled: false });

      await callStore.toggleSpeaker();

      expect(get(callStore).speaker).toBe(false);
    });

    it('puts the control back when the round trip fails', async () => {
      callStore.setStatus('connected', true);
      vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('timeout'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await callStore.toggleSpeaker();

      expect(get(callStore).speaker).toBe(false);
    });

    it('does nothing where the speaker was never offered', async () => {
      callStore.setStatus('connected', false);
      const nui = vi.spyOn(fetchNuiModule, 'fetchNui');

      await callStore.toggleSpeaker();

      expect(nui).not.toHaveBeenCalled();
      expect(get(callStore).speaker).toBe(false);
    });

    it('forgets availability when the call ends', () => {
      callStore.setStatus('connected', true);
      callStore.setStatus('idle');
      expect(get(callStore).speakerAvailable).toBe(false);
    });
  });
});
