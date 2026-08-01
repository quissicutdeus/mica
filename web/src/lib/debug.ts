import { isBrowser } from './isBrowser';

interface DebugEvent {
  action: string;
  data: any;
}

/**
 * Emulates dispatching an event to the NUI frame.
 * This is used for developing in the browser.
 * @param events - The event(s) to dispatch
 * @param timer - The time to wait before dispatching the event
 */
export const debugData = (events: DebugEvent[], timer = 1000) => {
  if (isBrowser()) {
    for (const event of events) {
      setTimeout(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              action: event.action,
              data: event.data
            }
          })
        );
      }, timer);
    }
  }
};
