# A text's live push is a raw net event, not an app-event push

`Messages.deliverToParticipants` sends
`emitNet('mica:client:messages:received', source, …)` straight to each online
recipient's source. It never goes through `appEventChannel`, so
`appEvents.setPushCapture` never sees it, and before MICA-397's bridge resolver
a synthetic recipient had no source at all.

**Why it matters:** the integration door's `waitForPush` reads only what the
door buffered. A scenario that waits on a text's push needs the door's
`captureEmitNet`, which stores an emit to a synthetic source as
`{ app: 'net', event: <name>, payload }`.

**How to apply:** before an in-server scenario waits on a push, check which path
the handler uses: `appEventChannel` (envelope keeps its own `app`) or a direct
`emitNet` (`app: 'net'`).
