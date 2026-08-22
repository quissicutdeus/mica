# The add-on catalog

A `CatalogEntry` (`web/src/shell/state/catalog.ts`) is what an operator's Store backend serves
to describe an installable `core: false` add-on. It is not the bundle, and the bundle is never
read to fill in what the entry doesn't say.

```ts
interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  bundleUrl: string;
  /** Lowercase hex SHA-256 of the exact bytes at `bundleUrl`. Required. */
  sha256: string;
  color: string;
  icon?: string;
  /** What this app discloses it reaches for — shown to a player before they install it. */
  permissions: AppPermission[];
  /** Whether the phone should block this app while signal is out. Defaults to `false`. */
  requiresNetwork?: boolean;
}
```

`isCatalogEntry` (same file) validates a value has every field with the right primitive type
before anything downstream trusts it.

## The manifest comes from the entry, not the code

`installFromCatalog`/rehydration build the app's `AppManifest` out of the `CatalogEntry` fields
directly — `name`, `color`, `icon`, `permissions`, and so on. Nothing ever `import()`s the
fetched bundle to ask it what it claims to be. That used to be how a remote app's manifest was
discovered — the old loader executed fetched code to learn its manifest — and it meant a
bundle's own code decided what the Store showed a player before they installed it, which is
exactly the thing a catalog is supposed to prevent. That loader is gone. A saved remote install from before this change is dropped on rehydration
with a console warning, since there is no path left to recover a manifest from it.

## Fetch and verify

`installVerified` in `web/src/shell/state/registry.ts` is the one path both `installFromCatalog`
and boot-time rehydration use:

1. Refuse a `data:` `bundleUrl` outright — a catalog entry is external input, and a `data:` URL
   would run inline source with no host check and no hash to verify.
2. Refuse a `bundleUrl` whose host isn't on the trusted-remote-app allowlist
   (`web/src/shell/state/remoteAppSecurity.ts`'s `setTrustedRemoteAppHosts`/
   `getTrustedRemoteAppHosts`), empty by default until an operator configures their own catalog
   host.
3. Fetch the bytes, hash them, and compare against `entry.sha256`. A mismatch refuses the
   install. A pinned hash re-verifies on every boot, not just at install time, so a bundle
   swapped out server-side after install is refused rather than silently re-run.
4. Only bytes that clear all three are handed to the sandboxed iframe to run.

## The bundle itself must be self-contained

A `core: false` add-on's build (`web/vite.addon.config.ts` +
`web/scripts/build-addons.mjs`, `pnpm --filter web build:addons`) produces one minified,
self-contained JS file per add-on — no import map, no runtime dependency on anything the shell
serves. The built-in add-ons land at `web/public/addons/<id>.js` (gitignored); an
operator-hosted catalog entry's `bundleUrl` points at the equivalent file on their own host.

The bundle's `default`/`manifest` exports, if any, are not read by the shell — that information
now lives on the `CatalogEntry` instead (see above). What the shell actually calls is
`bootAddOn` (`@gphone/sdk`, re-exported from `web/src/sdk/host/iframe/boot.ts`), which the
bundle's own entry code is expected to invoke once it's running inside the sandboxed frame —
`hello`-handshaking with the shell, then waiting for `hydrate` before rendering. See
[`docs/writing-an-app.md`](writing-an-app.md#your-app-runs-in-a-frame) for what the sandbox
means for the app code itself, and [`docs/security.md`](security.md) for the trust model this
supports.
