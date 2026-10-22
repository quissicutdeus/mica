# Sealing a column applies its rules to server writes

`Repository.sealForInsert`/`sealForUpdate` check each sealed value's plaintext
before sealing, on every write path, because sealed text is longer than plain
text and a truncated ciphertext can never be opened again. Until MICA-431 that
check was the whole `assertWritableValue`, which includes `accepts`. That is a
rule about what a client may send. Sealing `mica_media.data`, whose `accepts`
allows only an inline image, made `shareLocation` fail: it writes a location's
JSON through `addForPlayer`. Every suite was green except the one `media.test`
case that went through that path.

The seal now calls `assertFitsColumn`, which checks only length and `ascii`.
Those two are all a sealed width depends on. When you seal a column with
`accepts`, `values` or a client-only rule, look for every server writer of it.

Two more traps from the same sealing work:

- A `mediumtext` is exported by `Privacy.ts` as `<column>_bytes` (its size, like
  a media blob), never its words. Retyping a player's text column to
  `mediumtext` to fit ciphertext would remove it from their privacy export.
  MICA-431 kept `mica_notes.content` as `text` and lowered its bound, as
  MICA-165 did for Mail.
- Once a column is in the registry, `micacrypt backfill` seals it, so a separate
  pass that blanks it (DM notification bodies) must run first and skip sealed
  values. Otherwise each run blanks a sealed `''` and the walk seals it again.

Related: [[new-column-trips-the-privacy-pin]],
[[one-stub-phone-hides-a-device-binding]].
