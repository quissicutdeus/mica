# One stub phone for everyone hides a device binding

`installTestPhone` (`server/__tests__/phoneStub.ts`) answers `TEST_PHONE_ID` for
every citizen. A test that a value is sealed to the **recipient's** phone, not
copied from the sender's (MICA-431's media `copyToPlayers`), passes on the
broken code when the source row is on `TEST_PHONE_ID` too: both bindings are the
same phone, so both open. Break-to-prove caught it. Sealing the copy to
`source.device_id` stayed green until the source got a phone of its own
(`'c'.repeat(32)`).

So in any device-bound test, give each party a different `device_id`, and assert
the stored row's `device_id` before opening it. Opening under "another phone"
proves nothing unless that phone is the one the bug would use.

The citizenid is no help here. A phone-bound AAD does not name it, so changing
`citizenid` in the test row checks the handover, not the binding.

Related: [[negative-check-needs-a-positive-twin]],
[[break-to-prove-needs-the-file-in-fence]].
