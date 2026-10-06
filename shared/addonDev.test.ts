// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  ADDON_DEV_ENTRY,
  ADDON_DEV_QUERY,
  MICA_ADDON_MOCK_MARKER,
  MICA_DEV_ADDON_MARKER,
  parseLoopbackBase,
  sameOriginAs
} from './addonDev';

const accepted = (raw: string): string => {
  const result = parseLoopbackBase(raw);
  if (!result.ok) throw new Error(`refused '${raw}': ${result.reason}`);
  return result.base.href;
};

const refused = (raw: string): string => {
  const result = parseLoopbackBase(raw);
  if (result.ok) throw new Error(`accepted '${raw}' as ${result.base.href}`);
  return result.reason;
};

describe('the names', () => {
  it('are the strings the shell, the template and the build checks all key on', () => {
    expect(ADDON_DEV_QUERY).toBe('addonDev');
    expect(ADDON_DEV_ENTRY).toBe('mica-dev.json');
    expect(MICA_DEV_ADDON_MARKER).toBe('mica-dev-addon');
    expect(MICA_ADDON_MOCK_MARKER).toBe('mica-addon-mock');
  });
});

describe('parseLoopbackBase', () => {
  it.each([
    ['http://localhost:5174/', 'http://localhost:5174/'],
    ['http://127.0.0.1:5174/', 'http://127.0.0.1:5174/'],
    ['http://[::1]:5174/', 'http://[::1]:5174/'],
    ['https://localhost/', 'https://localhost/'],
    ['http://127.0.0.1:5174/sub/dir/', 'http://127.0.0.1:5174/sub/dir/']
  ])('accepts the three loopback spellings over http and https, any port: %s', (raw, href) => {
    expect(accepted(raw)).toBe(href);
  });

  it.each([
    ['http://localhost:0/', 'http://localhost:0/'],
    ['http://localhost:65535/', 'http://localhost:65535/']
  ])('accepts any port, since a port does not leave the machine: %s', (raw, href) => {
    expect(accepted(raw)).toBe(href);
  });

  it.each([
    ['http://127.1/', 'http://127.0.0.1/'],
    ['http://0x7f.0.0.1/', 'http://127.0.0.1/'],
    ['http://2130706433/', 'http://127.0.0.1/'],
    ['http://017700000001/', 'http://127.0.0.1/'],
    ['http://127.0.0.1./', 'http://127.0.0.1/'],
    ['http://127.0.0.1%2e/', 'http://127.0.0.1/']
  ])(
    'accepts a shorthand IPv4 for 127.0.0.1, because the browser parses it to 127.0.0.1 before it connects: %s',
    (raw, href) => {
      expect(accepted(raw)).toBe(href);
    }
  );

  it('accepts the long form of ::1, because the parser compresses it to [::1]', () => {
    expect(accepted('http://[0:0:0:0:0:0:0:1]/')).toBe('http://[::1]/');
  });

  it.each([
    ['HTTP://LOCALHOST/', 'http://localhost/'],
    ['http://LocalHost:5174/', 'http://localhost:5174/'],
    ['http://%6c%6fcalhost/', 'http://localhost/'],
    ['http://local\thost/', 'http://localhost/'],
    ['http:\\\\localhost\\', 'http://localhost/']
  ])(
    'accepts case, percent-encoding, a stray tab and backslashes, because each parses to plain localhost: %s',
    (raw, href) => {
      expect(accepted(raw)).toBe(href);
    }
  );

  it.each([
    ['http://ⅼocalhost/', 'http://localhost/'],
    ['http://ｌｏｃａｌｈｏｓｔ/', 'http://localhost/']
  ])(
    'accepts a Unicode lookalike only when IDNA maps it to localhost itself, so the request goes there: %s',
    (raw, href) => {
      expect(accepted(raw)).toBe(href);
    }
  );

  it.each([
    ['http://localhost', 'http://localhost/'],
    ['http://localhost:5174', 'http://localhost:5174/'],
    ['http://localhost/a/../', 'http://localhost/'],
    ['http://localhost/%2e%2e/', 'http://localhost/'],
    ['http://@localhost/', 'http://localhost/'],
    ['http://localhost:/', 'http://localhost/']
  ])(
    'accepts what serializes to a bare origin and directory, and hands back that serialization: %s',
    (raw, href) => {
      expect(accepted(raw)).toBe(href);
    }
  );

  it.each([
    'http://127.0.0.2/',
    'http://127.255.255.255/',
    'http://0.0.0.0/',
    'http://0/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/'
  ])(
    'refuses a loopback-range or wildcard address that is not one of the three spellings: %s',
    (raw) => {
      expect(refused(raw)).toMatch(/not loopback/);
    }
  );

  it.each([
    'http://localhost./',
    'http://LOCALHOST%2e/',
    'http://x.localhost/',
    'http://localhost.evil.com/',
    'http://localhost.localdomain/',
    'http://evil.com/',
    'http://xn--localhost-/',
    'http://xn--lcalhost-r2a/'
  ])(
    'refuses a name that merely resembles localhost, since its resolver is not ours: %s',
    (raw) => {
      expect(refused(raw)).toMatch(/not loopback/);
    }
  );

  it.each([
    'http://localhost@evil.com/',
    'http://evil.com\\@localhost/',
    'http://127.0.0.1:80@evil.com/'
  ])('refuses userinfo that hides the real host, which is judged instead: %s', (raw) => {
    expect(refused(raw)).toMatch(/not loopback/);
  });

  it('is not fooled by a backslash before userinfo: the host is localhost and the rest is path', () => {
    // `\` ends the authority on a special scheme, so `@evil.com/` is a path segment.
    expect(accepted('http://localhost\\@evil.com/')).toBe('http://localhost/@evil.com/');
  });

  it.each(['http://user@localhost/', 'http://user:pass@localhost/', 'http://:pass@localhost/'])(
    'refuses credentials on a loopback host, which a base has no use for: %s',
    (raw) => {
      expect(refused(raw)).toMatch(/username or password/);
    }
  );

  it.each([
    'http://localhost/?',
    'http://localhost/?x=1',
    'http://localhost/#',
    'http://localhost/#frag',
    'http://localhost/dir/?a'
  ])('refuses a query or a fragment, even an empty one: %s', (raw) => {
    expect(refused(raw)).toMatch(/no query and no fragment/);
  });

  it.each(['http://localhost/mica-dev.json', 'http://localhost:5174/dist'])(
    'refuses a path not ending in /, naming the directory form: %s',
    (raw) => {
      expect(refused(raw)).toMatch(/ends in '\/'/);
    }
  );

  it.each([
    'ftp://localhost/',
    'file:///tmp/',
    'ws://localhost/',
    'javascript:alert(1)//',
    'data:text/html,<p>/',
    'blob:http://localhost/x/'
  ])('refuses a protocol other than http and https: %s', (raw) => {
    expect(refused(raw)).toMatch(/http or https/);
  });

  it.each(['', 'localhost:5174/', '127.0.0.1/', '//localhost/', 'http://local host/'])(
    'refuses what is not an absolute URL: %j',
    (raw) => {
      expect(parseLoopbackBase(raw).ok).toBe(false);
    }
  );

  it('refuses a forbidden host code point instead of truncating at it', () => {
    expect(parseLoopbackBase('http://localhost%00/').ok).toBe(false);
  });

  it('refuses an over-long value before parsing it', () => {
    expect(refused(`http://localhost/${'a/'.repeat(2048)}`)).toMatch(/at most/);
  });

  it('refuses a non-string defensively, since a query value can arrive as anything', () => {
    expect(parseLoopbackBase(undefined as unknown as string).ok).toBe(false);
  });
});

describe('sameOriginAs', () => {
  const base = new URL('http://127.0.0.1:5174/');

  it('resolves a relative URL against the base, which is how a dev catalog names its bundle', () => {
    expect(sameOriginAs(base, 'bundle.js')).toBe(true);
    expect(sameOriginAs(base, './assets/index.js')).toBe(true);
    expect(sameOriginAs(base, '/x.js')).toBe(true);
  });

  it('accepts an absolute URL on the same origin, as a string or a URL', () => {
    expect(sameOriginAs(base, 'http://127.0.0.1:5174/bundle.js')).toBe(true);
    expect(sameOriginAs(base, new URL('http://127.0.0.1:5174/a/b.js'))).toBe(true);
  });

  it.each([
    ['another port', 'http://127.0.0.1:5175/bundle.js'],
    ['another loopback spelling, which is another origin', 'http://localhost:5174/bundle.js'],
    ['another scheme', 'https://127.0.0.1:5174/bundle.js'],
    ['a protocol-relative escape', '//evil.com/bundle.js'],
    ['a remote host', 'https://mica.gg/bundle.js'],
    ['a data URL', 'data:text/javascript,alert(1)'],
    [
      'a blob URL, whose origin is its creator but whose bytes are not served here',
      'blob:http://127.0.0.1:5174/abc'
    ],
    ['an unparseable URL', 'http://[::1/']
  ])('refuses %s', (_label, url) => {
    expect(sameOriginAs(base, url)).toBe(false);
  });
});
