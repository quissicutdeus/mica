// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTransport,
  setTransport,
  MockTransportAdapter,
  NuiTransportAdapter,
  WebSocketTransportAdapter,
  createWebSocketTransport,
  type ITransportAdapter
} from './transport';

class FakeWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    if (this.onclose) {
      this.onclose();
    }
  }

  // Helper methods for test control
  triggerOpen() {
    if (this.onopen) this.onopen();
  }

  triggerMessage(data: string) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

  triggerClose() {
    if (this.onclose) this.onclose();
  }

  static instances: FakeWebSocket[] = [];
  static clear() {
    FakeWebSocket.instances = [];
  }
}

describe('Transport Abstraction Module', () => {
  beforeEach(() => {
    setTransport(null);
    FakeWebSocket.clear();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('selects MockTransportAdapter in browser environment', () => {
    const transport = getTransport();
    expect(transport).toBeInstanceOf(MockTransportAdapter);
  });

  it('allows custom transport adapter injection via setTransport', async () => {
    const customAdapter: ITransportAdapter = {
      send: vi.fn().mockResolvedValue({ custom: true }),
      on: vi.fn().mockReturnValue(() => {})
    };

    setTransport(customAdapter);

    const transport = getTransport();
    expect(transport).toBe(customAdapter);

    const result = await transport.send('testEvent', { payload: 123 });
    expect(result).toEqual({ custom: true });
    expect(customAdapter.send).toHaveBeenCalledWith('testEvent', { payload: 123 });
  });

  it('NuiTransportAdapter issues HTTP POST request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve({ success: true })
    } as Response);

    const nuiTransport = new NuiTransportAdapter();
    const result = await nuiTransport.send('customNuiEvent', { foo: 'bar' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://gphone/customNuiEvent',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ foo: 'bar' })
      })
    );
    expect(result).toEqual({ success: true });
  });

  it('NuiTransportAdapter.on listens to window message events and unbinds correctly', () => {
    const nuiTransport = new NuiTransportAdapter();
    const handlerSpy = vi.fn();

    const unsubscribe = nuiTransport.on('testAction', handlerSpy);

    const event = new MessageEvent('message', {
      data: { action: 'testAction', data: { test: 1 } }
    });
    window.dispatchEvent(event);

    expect(handlerSpy).toHaveBeenCalledWith({ test: 1 });

    unsubscribe();

    handlerSpy.mockClear();
    window.dispatchEvent(event);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  describe('WebSocketTransportAdapter', () => {
    it('initializes and connects when autoConnect is true', () => {
      const adapter = createWebSocketTransport('ws://localhost:9001');
      expect(adapter.getStatus()).toBe('connecting');
      expect(FakeWebSocket.instances.length).toBe(1);

      const fakeWs = FakeWebSocket.instances[0];
      fakeWs.triggerOpen();
      expect(adapter.getStatus()).toBe('connected');
    });

    it('sends RPC message over WebSocket and resolves on correlated response', async () => {
      const adapter = new WebSocketTransportAdapter({ url: 'ws://localhost:9001' });
      const fakeWs = FakeWebSocket.instances[0];
      fakeWs.triggerOpen();

      const sendPromise = adapter.send('getContacts', { query: 'John' });

      expect(fakeWs.sentMessages.length).toBe(1);
      const parsed = JSON.parse(fakeWs.sentMessages[0]);
      expect(parsed.event).toBe('getContacts');
      expect(parsed.data).toEqual({ query: 'John' });
      expect(parsed.id).toBeDefined();

      // Trigger incoming response matching correlation ID
      fakeWs.triggerMessage(JSON.stringify({ id: parsed.id, data: [{ name: 'John Doe' }] }));

      const result = await sendPromise;
      expect(result).toEqual([{ name: 'John Doe' }]);
    });

    it('rejects RPC request when server responds with an error payload', async () => {
      const adapter = new WebSocketTransportAdapter({ url: 'ws://localhost:9001' });
      const fakeWs = FakeWebSocket.instances[0];
      fakeWs.triggerOpen();

      const sendPromise = adapter.send('invalidEvent');
      const parsed = JSON.parse(fakeWs.sentMessages[0]);

      fakeWs.triggerMessage(JSON.stringify({ id: parsed.id, error: 'Unauthorized request' }));

      await expect(sendPromise).rejects.toThrow('Unauthorized request');
    });

    it('rejects RPC request on timeout', async () => {
      const adapter = new WebSocketTransportAdapter({ url: 'ws://localhost:9001', timeout: 1000 });
      const fakeWs = FakeWebSocket.instances[0];
      fakeWs.triggerOpen();

      const sendPromise = adapter.send('slowEvent');

      vi.advanceTimersByTime(1001);

      await expect(sendPromise).rejects.toThrow("WebSocket request timeout for event 'slowEvent'");
    });

    it('receives broadcast events and dispatches to listeners & window', () => {
      const adapter = new WebSocketTransportAdapter({
        url: 'ws://localhost:9001',
        dispatchWindowMessages: true
      });
      const fakeWs = FakeWebSocket.instances[0];
      fakeWs.triggerOpen();

      const listenerSpy = vi.fn();
      const windowSpy = vi.fn();

      const unsubscribe = adapter.on('incomingCall', listenerSpy);
      window.addEventListener('message', (e) => windowSpy(e.data));

      fakeWs.triggerMessage(
        JSON.stringify({ action: 'incomingCall', data: { caller: '555-0199' } })
      );

      expect(listenerSpy).toHaveBeenCalledWith({ caller: '555-0199' });

      // Advance timers to allow jsdom postMessage queue to dispatch
      vi.advanceTimersByTime(10);
      expect(windowSpy).toHaveBeenCalledWith({
        action: 'incomingCall',
        data: { caller: '555-0199' }
      });

      unsubscribe();
    });

    it('handles disconnection and auto-reconnection attempts', () => {
      const adapter = new WebSocketTransportAdapter({
        url: 'ws://localhost:9001',
        reconnectInterval: 2000,
        maxReconnectAttempts: 2
      });
      const fakeWs1 = FakeWebSocket.instances[0];
      fakeWs1.triggerOpen();
      expect(adapter.getStatus()).toBe('connected');

      // Trigger unexpected drop
      fakeWs1.triggerClose();
      expect(adapter.getStatus()).toBe('disconnected');

      // Fast forward time to trigger reconnect
      vi.advanceTimersByTime(2000);
      expect(FakeWebSocket.instances.length).toBe(2);
      expect(adapter.getStatus()).toBe('connecting');

      const fakeWs2 = FakeWebSocket.instances[1];
      fakeWs2.triggerOpen();
      expect(adapter.getStatus()).toBe('connected');
    });

    it('cleans up pending requests on explicit disconnect', async () => {
      const adapter = new WebSocketTransportAdapter({ url: 'ws://localhost:9001' });
      const fakeWs = FakeWebSocket.instances[0];
      fakeWs.triggerOpen();

      const sendPromise = adapter.send('pendingRequest');
      adapter.disconnect();

      expect(adapter.getStatus()).toBe('disconnected');
      await expect(sendPromise).rejects.toThrow('WebSocket disconnected');
    });
  });
});
