# An own `__proto__` key needs `JSON.parse`

In an object literal, `{ __proto__: x }` sets the prototype. It does not create
a key, so a hostile-payload case built that way tests nothing and stays green.
`JSON.parse('{"__proto__":{...}}')` does create an own `__proto__` property.
That is also what a page's JSON body most likely becomes, though CEF's decode
into the scripting runtime is unverified in game.

Build every hostile payload with `JSON.parse`. Merge a base into it with
`Object.assign(parsed, base)`, not a spread into a literal. MICA-466's sweep
does both.
