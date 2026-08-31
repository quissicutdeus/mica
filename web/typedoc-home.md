# @gphone/sdk

The contract every gPhone app and every out-of-tree add-on is built against.
Apps reach the phone strictly through this package: the shell's own pieces —
`PhoneFrame`, `Launcher`, `ToastHost`, `ErrorBoundary` — are deliberately not
exported, and an app that draws its own phone frame is a bug.

## `@gphone/sdk` is two barrels wearing one name

The specifier an app writes is always `@gphone/sdk`. **Which file it resolves to
is decided by the bundle being built, not by the import**, and the two files do
not export quite the same set:

| Module  | File           | Resolved by                | Who gets it                                                 |
| ------- | -------------- | -------------------------- | ----------------------------------------------------------- |
| `index` | `sdk/index.ts` | `web/vite.config.ts`       | the phone's own shell and its `core: true` apps, in-process |
| `addon` | `sdk/addon.ts` | `web/vite.addon.config.ts` | an out-of-tree `core: false` add-on, in a sandboxed iframe  |
| `app`   | `sdk/app.ts`   | `@gphone/sdk/app`          | a manifest file, and only a manifest file                   |
| `core`  | `sdk/core.ts`  | `@gphone/sdk/core`         | a `core: true` app that needs the raw NUI transport         |

**If you are writing a Store add-on, `addon` is your surface.** It is the one
that has `bootAddOn`, which is the function your bundle must call; a
`core: false` bundle has no NUI at all and reaches the shell only through the
`postMessage` protocol `bootAddOn` sets up.

`app` exists because a manifest has to be loadable before the SDK is — importing
the main barrel from a manifest closes an import cycle and every binding comes
out `undefined`. `core` is the surface a sandboxed add-on is refused:
`useNuiBridge` can invoke any registered NUI callback by name, so it would
defeat every permission the sandbox exists to enforce.

Both `index` and `addon` are documented here on purpose. Neither is "the" barrel
— the question of what `@gphone/sdk`'s `.` export should ultimately resolve to
is open, and this site describes what each file exports today rather than
answering it.

## Which version is this?

The number in the header and the footer of every page is `SDK_CONTRACT_VERSION`,
from `sdk/version.ts`. It is the version of the exported surface itself — the
names each entry point publishes, the values you can call and the types you can
name alike, the props of every exported component, and the members of every
exported string vocabulary. It moves when that surface moves and at no other
time, which is what makes it the number worth pinning an add-on against.

It is deliberately **not** either of the other two numbers in this repo:

- `MICA_VERSION` is a CalVer stamp of the running phone build, computed from
  `git log` and moving on every push. An add-on branching on it is branching on
  noise, and an add-on bundle cannot know it anyway — it reads `''`.
- `package.json`'s `1.0.0` is a placeholder read by no code. Displaying it would
  advertise a published npm package that does not exist.

Nothing in the phone consults the contract version at install or boot time.
There is no runtime compatibility gate; this is a number you can read and act
on, not one the shell enforces for you.

## What this site cannot show

TypeDoc reads TypeScript, not Svelte. The SDK's UI primitives — `Screen`,
`Button`, `ListItem`, `Avatar` and the rest of `sdk/ui/` — are `.svelte` files,
so they are exported by these barrels but have no page here, and any type
declared inside a component's `<script>` block renders as `any`. Read `sdk/ui/`
in the repository for those.
