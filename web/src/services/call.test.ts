// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Stands in for the shell: `toast` reaches `audio.ts`, which reads the `persisted` facet at load.
import '../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callStore } from './call';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';
import { toast } from '../shell/state/toast';

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

  /**
   * MICA-473: since MICA-466 the client answers `{ error }` for a number the server would
   * refuse, and `fetchNui` throws on it. The store used to only log, so the call screen sat on
   * "Dialing..." with nobody on the line.
   */
  describe('a refused dial', () => {
    beforeEach(() => {
      callStore.setStatus('idle');
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('goes back to idle and says so in a toast', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('Invalid number'));
      const shown = vi.spyOn(toast, 'show').mockImplementation(() => 'toast');

      await callStore.startCall('   ', 'Nobody');

      expect(get(callStore)).toEqual(expect.objectContaining({ status: 'idle', number: '' }));
      expect(get(callStore).name).toBeUndefined();
      // The English text, not the key: Phone's catalog must be there even if Phone never mounted.
      expect(shown).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: "Couldn't call that number" })
      );
    });

    it('leaves a ring that arrived meanwhile alone', async () => {
      let refuse!: (e: Error) => void;
      vi.spyOn(fetchNuiModule, 'fetchNui').mockReturnValue(
        new Promise((_, reject) => (refuse = reject))
      );
      const shown = vi.spyOn(toast, 'show').mockImplementation(() => 'toast');

      const dial = callStore.startCall('555-0100');
      callStore.setIncoming('555-0199', 'Jane Smith');
      refuse(new Error('timeout'));
      await dial;

      expect(get(callStore)).toEqual(
        expect.objectContaining({ status: 'incoming', number: '555-0199' })
      );
      expect(shown).not.toHaveBeenCalled();
      callStore.setStatus('idle');
    });

    it('leaves a second dial alone when the first is refused late', async () => {
      const replies: Array<(e: Error) => void> = [];
      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(
        () => new Promise((_, reject) => replies.push(reject))
      );
      vi.spyOn(toast, 'show').mockImplementation(() => 'toast');

      const first = callStore.startCall('555-0100');
      void callStore.startCall('555-0142');
      replies[0](new Error('timeout'));
      await first;

      expect(get(callStore)).toEqual(
        expect.objectContaining({ status: 'dialing', number: '555-0142' })
      );
      callStore.setStatus('idle');
    });
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

    it('shows it off when the server withdraws it mid-call', async () => {
      callStore.setStatus('connected', true);
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ ok: true, enabled: true });
      await callStore.toggleSpeaker();
      expect(get(callStore).speaker).toBe(true);

      callStore.setStatus('connected', false);

      expect(get(callStore)).toEqual(
        expect.objectContaining({ status: 'connected', speaker: false, speakerAvailable: false })
      );
    });

    it('forgets availability when the call ends', () => {
      callStore.setStatus('connected', true);
      callStore.setStatus('idle');
      expect(get(callStore).speakerAvailable).toBe(false);
    });
  });

  /**
   * A ring that came in through a job line names the line (MICA-307) for as long as the call
   * lasts, and every way a call ends drops it — a "via Emergency" left over from the last
   * call would put a dispatcher on the wrong footing for the next one.
   */
  describe('job line', () => {
    const line = { number: '911', label: 'Emergency' };

    it('carries the line an incoming ring came in through, into the answered call', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);
      callStore.setIncoming('555-0188', 'Lamar Davis', line);
      expect(get(callStore).line).toEqual(line);

      await callStore.answerCall();
      expect(get(callStore).line).toEqual(line);
      callStore.setStatus('idle');
    });

    it('has none on an ordinary ring, even straight after a line call', () => {
      callStore.setIncoming('555-0188', undefined, line);
      callStore.setIncoming('555-0123', 'Jane Smith');
      expect(get(callStore).line).toBeUndefined();
    });

    it('clears when the server ends the call', () => {
      callStore.setIncoming('555-0188', undefined, line);
      callStore.setStatus('idle');
      expect(get(callStore).line).toBeUndefined();
    });

    it('clears when this player hangs up', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);
      callStore.setIncoming('555-0188', undefined, line);
      await callStore.endCall();
      expect(get(callStore).line).toBeUndefined();
    });

    it('is not carried into a call this player dials', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);
      callStore.setIncoming('555-0188', undefined, line);
      await callStore.startCall('555-0142');
      expect(get(callStore).line).toBeUndefined();
      callStore.setStatus('idle');
    });
  });
});
