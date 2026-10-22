# An unsynced key needs a synced owner to be swept

`hydrateSettingsOnCharacterLoad` (`host/facets/storage.ts`) skips every
`sync: false` key on purpose. Such a key has no server row, so a sweep keyed on
"the answer omitted it" would delete it on every login, including the same
character's. MICA-433 hit this with the wallpaper photo.

The fix that held: keep the heavy value unsynced and pair it with a small
**synced** key holding a fingerprint of that value (FNV-1a hex of the image).
The sweep clears or restores the fingerprint per identity. The exported store is
a custom `Writable` whose `subscribe` is a `derived` that shows the value only
when the fingerprint matches, and whose `set` writes both keys. Readers (shell,
Settings, the add-on facet) see the gated value.

Settings rows are per **device** as well as per character. So a fingerprint also
hides the photo on the tablet until it is set there. Deleting the value on a
mismatch, rather than hiding it, would lose it on a device switch.

Fail closed with an in-memory trust flag, never by writing `null` into the
synced key. A write queues a server save, and the sweep skips a pending key, so
the clear would be saved over the real row. `sweepAndTrust` in
`deviceIdentity.ts` distrusts before the sweep and trusts on success, with a
generation counter, as `lockScreen.ts` does for the auto-lock policy. Do not
import a state module into `host/facets/storage.ts`: that is the
facet-registration boot cycle.

An e2e that seeds a photo must also seed `mica:settings:wallpaperOwner`, holding
the fingerprint of the _normalized_ source (`wallpaperImage()` from
`@mica/shared/imageSource`). The mock answers a seeded key as a server row, so
it survives the sweep. `a11y.spec.ts` has the helper.

To test it, drive the real sweep with a mocked `services/settings`. Call
`flushPendingWrites()` first: a key with a write still pending is protected from
the sweep, and the test would then prove nothing.

Related: the mock registry strips `citizenid`/`device_id` from every reply not
in `CLIENT_ONLY_ACTIONS`, mirroring `server/lib/replyShape.ts`. Named routes
(`getContacts`) never pass through the generic branch, so a strip placed only
there misses them.
