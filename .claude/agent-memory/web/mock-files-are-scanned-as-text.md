# Mock service files are scanned as text

`server/__tests__/routes.test.ts` doesn't import
`web/src/nui/mocks/services/*.ts`. It reads them as text, with no Vite to run
their `import.meta.glob`. Restructuring a mock (MICA-264 split notes, settings
and the lockscreen per device) is safe only if three shapes survive:

- The file declares `export const mocks … = {` on one line and closes it with
  `\n};`. Only that slice is scanned.
- Each key sits at exactly two spaces of indent as `'svc:action':` or `name:`. A
  key nested one level deeper, for example inside a factory's returned object,
  doesn't count as a mock.
- `defineMockCrud` keeps a bare identifier as its first argument, matched by
  `defineMockCrud<T>(rows, { list: … })`. An expression there (`a ? b : []`)
  makes the scanner miss the call's keys. Wrapping the call is fine:
  `...perDeviceHandlers(state, (rows) => defineMockCrud<Note>(rows, …))` still
  matches.

A mock handler also gets a second argument now, `MockContext` with `{ device }`,
read off the generic envelope. To keep per-device state, use
`nui/mocks/perDevice.ts`.
