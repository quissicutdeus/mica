# A mocked promise is never unhandled

Vitest's `vi.fn` attaches its own handler to every promise it returns, to record
`mock.settledResults`. A rejection from `mockRejectedValueOnce` therefore never
reaches `process.on('unhandledRejection')`, and Vitest doesn't report it as an
unhandled error either. A test that checks "no unhandled rejection" with a
listener still passes after the `.catch` is deleted (found on MICA-264, in
`services/music.test.ts`).

What works is to hand the mock a promise made in the test, spy on its `catch`,
and assert that the code under test called it:

```ts
const refusal = Promise.reject(new Error('refused'));
const caught = vi.spyOn(refusal, 'catch');
fetchNui.mockReturnValueOnce(refusal);
```

An unhandled rejection made outside any mock (`void Promise.reject(...)`) still
reaches a `process` listener in the jsdom environment. A `window`
`unhandledrejection` listener does not see it.
