/**
 * Push a message into the UI.
 *
 * The one place that knows the envelope shape. It was called `NuiUtils`, which said
 * nothing about what was inside, and half the callers hand-rolled the
 * `SendNuiMessage(JSON.stringify(...))` instead of importing it.
 */
export const sendNuiMessage = (action: string, data: unknown) => {
  SendNuiMessage(JSON.stringify({ action, data }));
};
