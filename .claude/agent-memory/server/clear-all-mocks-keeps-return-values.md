# clearAllMocks keeps a mockReturnValue

`vi.clearAllMocks()` clears calls and results, not implementations. A
`mockReturnValue` or `mockImplementation` set by one test is still in force in
every later test of the file unless its own `beforeEach` sets it again.

MICA-436 hit it in `devices.test.ts`. Two new cases asserted the item gate
pushes `held: false` for a player holding only somebody else's phone. With the
gate broken to ignore slots and count instead, both still passed: an earlier
describe had left `bridgeMock.countItem` returning `0`, so the count said "not
held" too. The cases proved nothing until the describe's `beforeEach` pinned
`countItem` to `1`, the value that would make the broken path say "held".

**How to apply:** for a negative assertion, set every mock the wrong path would
read to the value that makes the wrong path give the other answer, in the
describe's own `beforeEach`. Then break the code and watch it fail.

Related: [[negative-check-needs-a-positive-twin]]
