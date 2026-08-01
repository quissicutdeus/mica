import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callStore } from './call';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../nui/fetchNui';

describe('callStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts call with dialing status and resets duration', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);

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
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);

    await callStore.answerCall();
    const state = get(callStore);

    expect(state.status).toBe('connected');
  });

  it('ends call and resets to initial state', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);

    await callStore.endCall();
    const state = get(callStore);

    expect(state.status).toBe('idle');
    expect(state.number).toBe('');
    expect(state.duration).toBe(0);
  });

  it('toggles speaker mode', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);

    const initialSpeaker = get(callStore).speaker;
    await callStore.toggleSpeaker();
    expect(get(callStore).speaker).toBe(!initialSpeaker);
  });
});
