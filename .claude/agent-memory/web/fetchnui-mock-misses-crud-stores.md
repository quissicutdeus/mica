# Mocking `nui/fetchNui` does not reach a CRUD store

An app test that does `vi.mock('../../nui/fetchNui', …)` (the Jobs and Notes
pattern) covers `useService(id).call(...)` and the typed `call(contract, …)`,
because both import that module. It does **not** cover a store built with
`createCrudStore`: that one imports `sdk/nui/transport`, which the mock never
installs, so its `load()` logs "no NUI transport is installed, so 'getContacts'
has nowhere to go" and keeps the last list.

Seed such a store directly instead — `contacts.set([...])` from
`../../services/contacts` in `beforeEach`. The failed foreground `load()` then
keeps exactly what you set. Answering `getContacts` in the mock's table does
nothing.

Second trap in the same tests: a `svc` call reaches `fetchNui` with a third
argument (`undefined`, or `{ defaultValue }` for a read), so
`toHaveBeenCalledWith('svc', expect.objectContaining(...))` fails on arity.
Filter `fetchNui.mock.calls` by `c[1]?.action` and assert on `slice(0, 2)` or
`toMatchObject` the payload.

Found on MICA-307 phase 2 (Jobs line inbox, 2026-10-05).
