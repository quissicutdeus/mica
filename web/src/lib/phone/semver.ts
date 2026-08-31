/**
 * Ordering two version strings, for the one question the Store has to answer: is what the
 * catalog offers *newer* than what the player has installed?
 *
 * A version reaches us as a bare `string` and nothing validates it — `CatalogEntry.version`
 * is an operator-authored field (`shell/state/catalog.ts`) checked only for being non-empty,
 * and an installed manifest's `version` is either that same string (a catalog install) or
 * `MICA_VERSION`, which `defineApp` supplies as the default.
 *
 * `MICA_VERSION` is **not** the repo's `package.json` version, which is what this comment
 * claimed until MICA-170. It is a CalVer stamp computed from `git log` at build time — and
 * inside an add-on bundle it is the **empty string**, because a bundle is compiled once and
 * then installed by whatever phone fetches it, so the host's build stamp is not knowable when
 * the bundle is written. That matters here specifically: an empty version reaches `parse`
 * below and comes back *not orderable*, so it takes the `null` path rather than being folded
 * into "up to date". Both are semver-shaped *by convention*, and neither is guaranteed to
 * be.
 *
 * So this parses rather than compares text. `'1.10.0' > '1.9.0'` is false as strings and true
 * as versions, and `'2.0' !== '2.0.0'` as strings while naming the same release — a string
 * inequality would have told a player with the current build that they were behind, which is
 * worse than saying nothing.
 *
 * What it accepts: an optional `v` prefix, a dot-separated numeric core of any length (missing
 * segments read as zero, so `2.0` and `2.0.0` are equal), an optional `-prerelease` compared
 * per semver §11, and a `+build` suffix which is ignored because semver says it carries no
 * precedence.
 *
 * What it refuses: everything else — a date stamp with slashes, a git sha, a channel name,
 * an empty string. Those get `null`, meaning *not orderable*, which callers must handle as
 * its own case rather than folding into "up to date".
 */

interface ParsedVersion {
  /** The dot-separated numeric core, e.g. `1.2.3` → `[1, 2, 3]`. */
  core: number[];
  /** Dot-separated prerelease identifiers, or `null` for a release version. */
  prerelease: string[] | null;
}

const NUMERIC = /^\d+$/;

/** `null` for anything this cannot read as a version, rather than a guess. */
function parseVersion(raw: string): ParsedVersion | null {
  let text = raw.trim();
  if (!text) return null;
  if (text[0] === 'v' || text[0] === 'V') text = text.slice(1);

  // Build metadata carries no precedence (semver §10), so it is dropped before anything
  // else — `1.0.0+a` and `1.0.0+b` are the same version.
  const plus = text.indexOf('+');
  if (plus >= 0) text = text.slice(0, plus);

  let prerelease: string[] | null = null;
  const dash = text.indexOf('-');
  if (dash >= 0) {
    const tail = text.slice(dash + 1);
    text = text.slice(0, dash);
    prerelease = tail.split('.');
    if (prerelease.some((id) => id.length === 0)) return null;
  }

  const core = text.split('.');
  if (core.some((part) => !NUMERIC.test(part))) return null;

  return { core: core.map(Number), prerelease };
}

/** Semver §11's prerelease rules: numeric identifiers compare as numbers and sort below alphanumeric ones, and a longer identifier set wins when every shared identifier is equal. */
function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xNumeric = NUMERIC.test(x);
    const yNumeric = NUMERIC.test(y);
    if (xNumeric && yNumeric) return Number(x) > Number(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  if (a.length === b.length) return 0;
  return a.length > b.length ? 1 : -1;
}

/**
 * `1` if `a` is newer, `-1` if older, `0` if the same version, and **`null` if the pair
 * cannot be ordered** — either side unparseable, or absent.
 *
 * The `null` is the point of the signature. A boolean would have to pick a side for the
 * unreadable case, and both sides are wrong: "newer" invents an update out of a typo, and
 * "not newer" is the silent "up to date" this whole feature exists to stop telling people.
 */
export function compareVersions(
  a: string | undefined | null,
  b: string | undefined | null
): -1 | 0 | 1 | null {
  if (typeof a !== 'string' || typeof b !== 'string') return null;

  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const width = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < width; i++) {
    // A missing segment is zero, so `2.0` and `2.0.0` are one version rather than two.
    const x = left.core[i] ?? 0;
    const y = right.core[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }

  // A prerelease sorts below the release it leads to: `1.0.0-rc.1` < `1.0.0` (semver §11).
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && right.prerelease)
    return comparePrerelease(left.prerelease, right.prerelease);
  return 0;
}
