import { parseRequestEvent, requestEventFor, responseEventFor } from '@shared/rpc';

export class ServiceProxy {
  private pendingCallbacks = new Map<string, Function>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idCounter = 0;
  /** Response events already subscribed, so several routes can share one. */
  private subscribed = new Set<string>();

  constructor(private serviceName: string) {}

  private generateId(): string {
    this.idCounter = (this.idCounter + 1) % 100000;
    return `${Date.now()}-${this.idCounter}`;
  }

  private handleResponse(cbId: string, data: any) {
    // Clear safety timer if it exists
    const timer = this.pendingTimers.get(cbId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(cbId);
    }

    if (this.pendingCallbacks.has(cbId)) {
      const cb = this.pendingCallbacks.get(cbId);
      this.pendingCallbacks.delete(cbId); // Clean up FIRST to prevent leaks on crash

      if (cb) {
        // Safe serialization check: handles `undefined` without throwing an error
        const cleanData = data !== undefined ? JSON.parse(JSON.stringify(data)) : null;
        cb(cleanData);
      }
    }
  }

  /**
   * Subscribe the event the server will reply on. Idempotent, because several NUI
   * actions can map to one server action — `deleteConversation` and `leaveConversation`
   * both reply on `gphone:client:conversations:deleted`.
   */
  private subscribeResponse(responseEvent: string) {
    if (this.subscribed.has(responseEvent)) return;
    this.subscribed.add(responseEvent);
    onNet(responseEvent, (cbId: string, data: any) => this.handleResponse(cbId, data));
  }

  /**
   * Wire a NUI action to a server event, and subscribe the reply.
   *
   * The response event is **derived** from the server event rather than registered
   * separately. Previously each app subscribed a fixed set of four CRUD reply names and
   * had to opt into anything else by hand; every custom action whose author forgot —
   * all four mail actions — timed out after 15 seconds with no error surfaced anywhere.
   */
  public registerCallback(action: string, customServerEvent?: string) {
    const nuiEvent = action;
    const serverEvent = customServerEvent || requestEventFor(this.serviceName, action);

    const target = parseRequestEvent(serverEvent);
    if (!target) {
      // A server event outside the gphone:server:<service>:<action> convention has no
      // derivable reply, so a caller would hang. Refuse loudly at startup instead.
      throw new Error(
        `[ServiceProxy:${this.serviceName}] '${serverEvent}' does not match ` +
          'gphone:server:<service>:<action>, so its response event cannot be derived.'
      );
    }
    this.subscribeResponse(responseEventFor(target.service, target.action));

    RegisterNuiCallbackType(nuiEvent);
    on(`__cfx_nui:${nuiEvent}`, (data: any, cb: Function) => {
      this.relay(action, serverEvent, data, cb);
    });
  }

  /**
   * Subscribe a service action's reply without registering a NUI callback for it.
   *
   * For the generic relay, which has one NUI callback for every service and therefore
   * cannot know at startup which replies it will need. Idempotent — `subscribeResponse`
   * dedupes — so calling it per request costs nothing after the first.
   */
  public ensureSubscribed(action: string) {
    this.subscribeResponse(responseEventFor(this.serviceName, action));
  }

  /**
   * Send one request and hold the NUI callback until the server answers.
   *
   * Split out of `registerCallback` so the generic relay can reuse it verbatim: the
   * timeout, the pending-callback bookkeeping and the reply correlation are the parts
   * that must not be reimplemented, because getting any of them subtly wrong produces a
   * request that hangs for 15 seconds and then returns a default value with no error
   * anywhere — the failure mode this whole layer exists to have exactly one copy of.
   */
  public relay(action: string, serverEvent: string, data: unknown, cb: Function) {
    const cbId = this.generateId();
    this.pendingCallbacks.set(cbId, cb);

    // 15-second safety timeout so NUI never hangs indefinitely
    const timer = setTimeout(() => {
      if (this.pendingCallbacks.has(cbId)) {
        console.warn(
          `[ServiceProxy:${this.serviceName}] Callback ${action} (${cbId}) timed out waiting for server response.`
        );
        const pendingCb = this.pendingCallbacks.get(cbId);
        this.pendingCallbacks.delete(cbId);
        this.pendingTimers.delete(cbId);
        if (pendingCb) {
          pendingCb({ error: 'Request timed out' });
        }
      }
    }, 15000);

    this.pendingTimers.set(cbId, timer);

    emitNet(serverEvent, cbId, data);
  }
}
