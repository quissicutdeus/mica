import { sendNuiMessage } from '../lib/NuiUtils';

/**
 * Shell-scoped client events — the ones that belong to the phone itself rather than to
 * any app.
 *
 * `shell` is the segment for these because the event name convention is
 * `gphone:<side>:<app>:<action>` and there is no app here. It matches what the rest of
 * the codebase already calls this layer.
 */

/**
 * A server-originated toast.
 *
 * The server has emitted this since the ace-denial paths were added, and **nothing was
 * listening** — five call sites across CallController and BatteryController pushed
 * notifications into the void, so a player denied permission saw no feedback at all.
 */
onNet(
  'gphone:client:shell:notify',
  (payload: { type?: string; title?: string; message?: string }) => {
    const message = typeof payload?.message === 'string' ? payload.message : '';
    if (!message) return;

    sendNuiMessage('notify', {
      type: payload?.type ?? 'info',
      title: payload?.title,
      message
    });
  }
);
