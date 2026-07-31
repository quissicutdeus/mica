export class ClientApp {
  private pendingCallbacks = new Map<string, Function>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idCounter = 0;

  constructor(private appName: string) {
    this.registerDefaultResponseListeners();
  }

  private generateId(): string {
    this.idCounter = (this.idCounter + 1) % 100000;
    return `${Date.now()}-${this.idCounter}`;
  }

  private registerDefaultResponseListeners() {
    this.onResponse('receive', (cbId, data) => this.handleResponse(cbId, data));
    this.onResponse('created', (cbId, data) => this.handleResponse(cbId, data));
    this.onResponse('updated', (cbId, data) => this.handleResponse(cbId, data));
    this.onResponse('deleted', (cbId, data) => this.handleResponse(cbId, data));
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

  public registerCallback(action: string, customServerEvent?: string) {
    const nuiEvent = action;
    const serverEvent = customServerEvent || `gphone:server:${this.appName}:${action}`;

    RegisterNuiCallbackType(nuiEvent);
    on(`__cfx_nui:${nuiEvent}`, (data: any, cb: Function) => {
      const cbId = this.generateId();
      this.pendingCallbacks.set(cbId, cb);

      // 15-second safety timeout so NUI never hangs indefinitely
      const timer = setTimeout(() => {
        if (this.pendingCallbacks.has(cbId)) {
          console.warn(
            `[ClientApp:${this.appName}] Callback ${action} (${cbId}) timed out waiting for server response.`
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
    });
  }

  public onResponse(action: string, handler: (cbId: string, data: any) => void) {
    const clientEvent = `gphone:client:${this.appName}:${action}`;
    onNet(clientEvent, handler);
  }

  public registerResponseListener(action: string) {
    this.onResponse(action, (cbId, data) => this.handleResponse(cbId, data));
  }
}
