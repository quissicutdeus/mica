# A thread page is the newest window, in send order

`messages:get` answers `{ rows, nextCursor }` where the rows are the newest page
of the thread (`ORDER BY m.id DESC LIMIT n`) and then reversed in
`MessageRepository.findByConversation` before they are returned. So `rows` is
oldest-to-newest inside that page, not newest first, even though the docblock
and the keyset both read "newest first".

`test:endpoints` (MICA-304) asserted newest first and failed. Assert the order
the text was sent in, and read the repository's final `reverse()` rather than
the `ORDER BY` when writing an expectation about a page.
