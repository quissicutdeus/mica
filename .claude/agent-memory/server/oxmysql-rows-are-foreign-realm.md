# A row from oxmysql fails a prototype check

oxmysql answers across a resource boundary, so the objects it hands back are
built in another realm: `Object.getPrototypeOf(row) === Object.prototype` is
false for every real row, though it is true for every row a suite's `dbMock`
returns. A walker that recurses only into "plain objects" by prototype passes
every test and skips every row in game.

MICA-433's `withoutOwnerKeys` (`server/lib/replyShape.ts`) strips `citizenid`
and `device_id` from every reply. It walks anything object-shaped except a
`Date` and binary data, and `replyShape.test.ts` proves it on a row made with
`runInNewContext`, the same shape a cross-resource row has.

**How to apply:** never decide "is this a record" by prototype or
`instanceof Object` on data that came through `Database`. Build the test fixture
in another realm (`node:vm`) so the suite can fail. Errors have the same trap;
see [oxmysql-errors-carry-no-errno](oxmysql-errors-carry-no-errno.md).
