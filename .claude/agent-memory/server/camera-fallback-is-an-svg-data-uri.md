# The camera's failure fallback is an SVG data URI

A rule on what a client may store in `mica_media.data` has to admit two shapes,
not one. The camera encodes a raster base64 data URI. When `screencapture`
returns nothing, it saves `sampleAvatars[0]` instead: a URL-encoded
`data:image/svg+xml,…` from `sdk/lib/placeholderImage.ts`, in game as well as in
the mock. A raster-only rule would turn a failed capture into a
`camera.saveFailed` toast. No suite shows that, because the mock never reaches
the server.

MICA-339 admits the SVG form in `server/lib/media/clientWrite.ts`. The charset
is only what `encodeURIComponent` leaves, less `'`. `media.test.ts` stores a
real `placeholderPhoto()` as its positive twin, so a rule that narrows to
raster-only fails there.

Second trap from the same change: a status check added to a shared helper
(`resolveOwnedAttachments`) passed its own suite and failed Marketplace and
Blabber. Their `findById` fixtures returned rows with no `status`. Run the whole
`server/__tests__` directory after changing a helper that other services call.
