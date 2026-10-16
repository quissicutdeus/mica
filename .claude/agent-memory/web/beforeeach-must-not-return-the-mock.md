# A `beforeEach` arrow must not return the mock

`beforeEach(() => mock.mockReset())` returns the mock, and Vitest treats a
function returned from `beforeEach` as that hook's teardown, so it calls the
stub after every test. With a refusing stub (one that throws, as a fetchNui
failure stub does), every case then fails with the stub's own error, which looks
like a broken test rather than a broken hook.

**How to apply:** give the hook a block body,
`beforeEach(() => { mock.mockReset(); })`, so it returns nothing. Found in
MICA-384.
