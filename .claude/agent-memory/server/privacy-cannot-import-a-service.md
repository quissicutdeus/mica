# Privacy.ts cannot import a service that reaches Devices

`lib/shell.ts` imports `services/Privacy.ts` at module scope, for
`SELF_SERVICE_EXCEPT`, and computes `CHARACTER_EXCEPT` from it right away. Any
service that imports `services/Devices.ts` reaches `lib/shell.ts` through
`lib/deviceItem.ts`, and that includes Conversations. If Privacy imported such a
service, the import would close a cycle:
`Privacy -> Conversations -> Devices -> deviceItem -> shell -> Privacy`. `tsc`
is happy with it. At runtime the result depends on which module loads first, and
the failure is a TDZ `ReferenceError`.

MICA-342 needed Conversations to act before a privacy delete. Privacy exposes
`onBeforeSelfServiceDelete(name, run)` and Conversations registers on it, the
same direction `onDeviceHandover` goes. A hook that throws fails the delete
before anything is purged.

To check a new import edge, walk the relative imports from the importer and see
whether they reach the importee. Grepping one level deep missed this cycle. A
throwaway BFS over `from '…'` specifiers took twenty lines. Type-only imports do
not count, because they create no runtime edge.
