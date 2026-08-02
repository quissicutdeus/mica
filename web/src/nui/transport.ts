import { isBrowser } from '../lib/isBrowser';
import { MockRegistry } from './mocks/registry';

export interface ITransportAdapter {
  send<T = any>(event: string, data?: unknown): Promise<T>;
  on<T = any>(event: string, handler: (data: T) => void): () => void;
}

export class NuiTransportAdapter implements ITransportAdapter {
  private resourceName: string;

  constructor() {
    this.resourceName = window.GetParentResourceName ? window.GetParentResourceName() : 'gphone';
  }

  async send<T = any>(event: string, data?: unknown): Promise<T> {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(data)
    };

    const resp = await fetch(`https://${this.resourceName}/${event}`, options);
    const respFormatted = await resp.json();
    return respFormatted;
  }

  on<T = any>(event: string, handler: (data: T) => void): () => void {
    const eventListener = (e: MessageEvent) => {
      const { action, data } = e.data || {};
      if (action === event) {
        handler(data);
      }
    };
    window.addEventListener('message', eventListener);
    return () => window.removeEventListener('message', eventListener);
  }
}

export class MockTransportAdapter implements ITransportAdapter {
  async send<T = any>(event: string, data?: unknown): Promise<T> {
    if (MockRegistry.has(event)) {
      return (await MockRegistry.handle(event, data)) as T;
    }
    return null as unknown as T;
  }

  on<T = any>(event: string, handler: (data: T) => void): () => void {
    const eventListener = (e: MessageEvent) => {
      const { action, data } = e.data || {};
      if (action === event) {
        handler(data);
      }
    };
    window.addEventListener('message', eventListener);
    return () => window.removeEventListener('message', eventListener);
  }
}

export interface WebSocketTransportOptions {
  url: string;
  autoConnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  timeout?: number;
  dispatchWindowMessages?: boolean;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export class WebSocketTransportAdapter implements ITransportAdapter {
  private url: string;
  private autoConnect: boolean;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private timeout: number;
  private dispatchWindowMessages: boolean;

  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private pendingRequests = new Map<
    string,
    {
      // Deliberately `any`: one map holds the pending promise of every in-flight
      // request, each with its own `T`. There is no single type that is all of them.
      resolve: (value: any) => void;
      reject: (reason: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  // Same reason: one map, many payload shapes, each known only to its subscriber.
  private eventHandlers = new Map<string, Set<(data: any) => void>>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: string | WebSocketTransportOptions) {
    if (typeof options === 'string') {
      this.url = options;
      this.autoConnect = true;
      this.reconnectInterval = 3000;
      this.maxReconnectAttempts = 5;
      this.timeout = 10000;
      this.dispatchWindowMessages = true;
    } else {
      this.url = options.url;
      this.autoConnect = options.autoConnect ?? true;
      this.reconnectInterval = options.reconnectInterval ?? 3000;
      this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
      this.timeout = options.timeout ?? 10000;
      this.dispatchWindowMessages = options.dispatchWindowMessages ?? true;
    }

    if (this.autoConnect) {
      this.connect();
    }
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public connect(): void {
    if (this.ws || this.status === 'connecting') return;

    this.status = 'connecting';
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.handleCloseOrError();
      return;
    }

    this.ws.onopen = () => {
      this.status = 'connected';
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleIncomingMessage(event.data);
    };

    this.ws.onerror = () => {
      // Handled via onclose
    };

    this.ws.onclose = () => {
      this.handleCloseOrError();
    };
  }

  private handleCloseOrError(): void {
    this.ws = null;
    this.status = 'disconnected';

    if (
      this.autoConnect &&
      (this.maxReconnectAttempts === 0 || this.reconnectAttempts < this.maxReconnectAttempts)
    ) {
      this.reconnectAttempts++;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, this.reconnectInterval);
    }
  }

  public disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.autoConnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status = 'disconnected';

    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error('WebSocket disconnected'));
    }
    this.pendingRequests.clear();
  }

  private handleIncomingMessage(rawMessage: string): void {
    try {
      const payload = JSON.parse(rawMessage);

      // RPC response check
      if (payload.id && this.pendingRequests.has(payload.id)) {
        const { resolve, reject, timer } = this.pendingRequests.get(payload.id)!;
        clearTimeout(timer);
        this.pendingRequests.delete(payload.id);

        if (payload.error) {
          reject(new Error(payload.error));
        } else {
          resolve(payload.data);
        }
        return;
      }

      // Event broadcast check
      const eventName = payload.action || payload.event;
      if (eventName) {
        const handlers = this.eventHandlers.get(eventName);
        if (handlers) {
          handlers.forEach((h) => h(payload.data));
        }

        if (this.dispatchWindowMessages && typeof window !== 'undefined') {
          window.postMessage({ action: eventName, data: payload.data }, '*');
        }
      }
    } catch {
      // Ignore invalid JSON messages
    }
  }

  async send<T = any>(event: string, data?: unknown): Promise<T> {
    if (!this.ws || this.status !== 'connected') {
      throw new Error(`WebSocket is not connected (status: ${this.status})`);
    }

    const id = Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
    const message = JSON.stringify({ id, event, data });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`WebSocket request timeout for event '${event}'`));
        }
      }, this.timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.ws!.send(message);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  on<T = any>(event: string, handler: (data: T) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    const handlers = this.eventHandlers.get(event)!;
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(event);
      }
    };
  }
}

export function createWebSocketTransport(
  url: string,
  options?: Partial<WebSocketTransportOptions>
): WebSocketTransportAdapter {
  return new WebSocketTransportAdapter({ url, ...options });
}

let activeTransport: ITransportAdapter | null = null;

export function getTransport(): ITransportAdapter {
  if (!activeTransport) {
    if (isBrowser()) {
      activeTransport = new MockTransportAdapter();
    } else {
      activeTransport = new NuiTransportAdapter();
    }
  }
  return activeTransport;
}

export function setTransport(transport: ITransportAdapter | null): void {
  activeTransport = transport;
}
