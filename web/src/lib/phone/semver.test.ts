import { describe, it, expect } from 'vitest';
import { compareVersions } from './semver';

describe('compareVersions', () => {
  it('orders the numeric core numerically, not as text', () => {
    // The case a string comparison gets backwards, and the reason this module exists:
    // '1.10.0' < '1.9.0' as text, and is the newer release.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });

  it('treats a missing segment as zero, so 2.0 and 2.0.0 are one version', () => {
    // Otherwise a catalog that writes '2.0' and an install that recorded '2.0.0' would
    // read as a permanent, uninstallable update.
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('2', '2.0.0.0')).toBe(0);
    expect(compareVersions('2.0.1', '2.0')).toBe(1);
  });

  it('ignores a v prefix and build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build.9', '1.2.3+build.1')).toBe(0);
    expect(compareVersions('V1.2.4', '1.2.3+deadbeef')).toBe(1);
  });

  it('sorts a prerelease below the release it leads to', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones, and a longer set wins on a tie.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1);
  });

  it('returns null rather than guessing at anything it cannot read', () => {
    // `version` is an operator-authored string that nothing validates beyond non-empty.
    // Every one of these has to be a distinct "cannot order" answer, not a false update.
    for (const junk of [
      '',
      '   ',
      'nightly',
      '2024/01/02',
      '1.2.x',
      'deadbee',
      '1.-2.3',
      '1.0.0-'
    ]) {
      expect(compareVersions(junk, '1.0.0'), junk).toBeNull();
      expect(compareVersions('1.0.0', junk), junk).toBeNull();
    }
  });

  it('returns null for an absent version on either side', () => {
    expect(compareVersions(undefined, '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', undefined)).toBeNull();
    expect(compareVersions(null, null)).toBeNull();
  });
});
