// The client half of the settings service.

/**
 * Tell the phone to re-read this character's saved settings.
 *
 * One event with no payload, and that is the whole design. The settings themselves travel
 * over the ordinary `getSettings` NUI round trip, which already authenticates the caller
 * and scopes the read to their citizenid — pushing the rows down this event instead would
 * be a second way to deliver the same data, and the two would drift.
 *
 * It exists because the CEF page loads at resource start and **never unloads**. A player
 * who switches character without a resource restart keeps the previous character's phone
 * on screen, settings and all, which is the exact bug server-backed settings exist to fix.
 */
onNet('gphone:client:settings:rehydrate', () => {
  SendNuiMessage(
    JSON.stringify({
      action: 'rehydrateSettings',
      data: {}
    })
  );
});
