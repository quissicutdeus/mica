// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  isPlaylistId,
  isVideoId,
  isYouTubeSource,
  parseYouTubeSource,
  thumbnailUrlFor
} from '@mica/shared/youtube';

/**
 * MICA-111. The parser is the sanitisation boundary — everything downstream interpolates
 * what comes out of here into an `<iframe src>`, which is a navigation, so a string that
 * escapes it is not defacement but a redirect out of the CEF instance. Tested from
 * `web/src/lib/` beside `richText.test.ts`, which covers `@mica/shared/richText` the same way.
 */

const VIDEO = 'dQw4w9WgXcQ';
const PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

describe('parseYouTubeSource — links people actually paste', () => {
  it.each([
    ['https://www.youtube.com/watch?v=' + VIDEO],
    ['https://youtube.com/watch?v=' + VIDEO],
    ['https://m.youtube.com/watch?v=' + VIDEO],
    ['https://music.youtube.com/watch?v=' + VIDEO],
    ['https://youtu.be/' + VIDEO],
    ['https://www.youtube.com/embed/' + VIDEO],
    ['https://www.youtube-nocookie.com/embed/' + VIDEO],
    ['https://www.youtube.com/shorts/' + VIDEO],
    ['https://www.youtube.com/live/' + VIDEO],
    ['https://www.youtube.com/v/' + VIDEO],
    // No scheme, the way a paste from an address bar often arrives.
    ['youtu.be/' + VIDEO],
    // Surrounding whitespace from a copy that caught the line.
    ['  https://www.youtube.com/watch?v=' + VIDEO + '  ']
  ])('finds the video id in %s', (input) => {
    expect(parseYouTubeSource(input)).toEqual({ videoId: VIDEO, playlistId: null });
  });

  it('accepts a bare video id', () => {
    expect(parseYouTubeSource(VIDEO)).toEqual({ videoId: VIDEO, playlistId: null });
  });

  it('keeps both ids when a link names a video inside a playlist', () => {
    expect(parseYouTubeSource(`https://www.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}`)).toEqual(
      {
        videoId: VIDEO,
        playlistId: PLAYLIST
      }
    );
  });

  it('accepts a playlist with no entry video', () => {
    expect(parseYouTubeSource(`https://www.youtube.com/playlist?list=${PLAYLIST}`)).toEqual({
      videoId: null,
      playlistId: PLAYLIST
    });
  });

  it('ignores the tracking junk a share link carries', () => {
    expect(parseYouTubeSource(`https://youtu.be/${VIDEO}?si=abc123&t=42`)).toEqual({
      videoId: VIDEO,
      playlistId: null
    });
  });
});

describe('parseYouTubeSource — what it refuses', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['not a link at all', 'prose'],
    ['https://example.com/watch?v=' + VIDEO, 'a right-shaped link on the wrong host'],
    // The host allowlist is exact, so a lookalike registered by somebody else is refused.
    ['https://youtube.com.evil.test/watch?v=' + VIDEO, 'a suffix-matching lookalike host'],
    ['https://notyoutube.com/watch?v=' + VIDEO, 'a prefix-matching lookalike host'],
    ['javascript:alert(1)', 'a javascript: URL'],
    ['data:text/html,<script>alert(1)</script>', 'a data: URL'],
    ['https://www.youtube.com/', 'a YouTube link naming nothing'],
    ['https://www.youtube.com/watch?v=short', 'a v= that is not 11 characters'],
    ['https://www.youtube.com/watch?v=' + VIDEO + 'toolong', 'a v= that is too long'],
    ['https://www.youtube.com/playlist?list=tiny', 'a list= under the playlist floor']
  ])('refuses %s (%s)', (input) => {
    expect(parseYouTubeSource(input)).toBeNull();
  });

  it('refuses an id carrying characters that would escape an attribute', () => {
    // 11 characters, so length alone would pass — the alphabet is what rejects it.
    expect(parseYouTubeSource('https://www.youtube.com/watch?v=' + '"><script')).toBeNull();
    expect(parseYouTubeSource('abc"defghij')).toBeNull();
  });

  /**
   * The matcher is anchored and hand-written because `shared/` has no `URL` (see the file's
   * own comment). These are the cases a real URL parser would answer *differently* — and in
   * every one of them the safe answer is refusal, so this is what holds that down.
   */
  it.each([
    ['https://youtube.com@evil.test/watch?v=' + VIDEO, 'userinfo pointing at another host'],
    ['https://youtube.com:8080@evil.test/watch?v=' + VIDEO, 'userinfo with a port'],
    ['https://evil.youtube.com/watch?v=' + VIDEO, 'an unexpected subdomain'],
    ['https:\\\\youtu.be\\' + VIDEO, 'backslashes a browser would normalise'],
    ['ftp://www.youtube.com/watch?v=' + VIDEO, 'a scheme that is not http(s)'],
    ['  https://evil.test/#https://youtu.be/' + VIDEO, 'a YouTube link hidden in a fragment']
  ])('refuses %s (%s)', (input) => {
    expect(parseYouTubeSource(input)).toBeNull();
  });

  it('takes the first v=, so an appended one cannot override it', () => {
    expect(parseYouTubeSource(`https://www.youtube.com/watch?v=${VIDEO}&v=aaaaaaaaaaa`)).toEqual({
      videoId: VIDEO,
      playlistId: null
    });
  });

  it('ignores a fragment on an otherwise good link', () => {
    expect(parseYouTubeSource(`https://youtu.be/${VIDEO}#t=30`)).toEqual({
      videoId: VIDEO,
      playlistId: null
    });
  });

  it('refuses a percent-encoded id it cannot decode into the alphabet', () => {
    expect(parseYouTubeSource('https://www.youtube.com/watch?v=%2F%2Fevil%2F%2F')).toBeNull();
  });

  it('isYouTubeSource agrees with the parser, so a UI can ask before it acts', () => {
    // The app validates with this and then calls `playSource`, which parses again. The two
    // must never disagree, or a paste the screen accepted would silently play nothing.
    for (const input of [`https://youtu.be/${VIDEO}`, VIDEO, 'nonsense', '', 'https://x.test']) {
      expect(isYouTubeSource(input)).toBe(parseYouTubeSource(input) !== null);
    }
  });

  it('does not read an 11-character video id as a playlist', () => {
    expect(isPlaylistId(VIDEO)).toBe(false);
    expect(isVideoId(VIDEO)).toBe(true);
  });
});

describe('thumbnailUrlFor', () => {
  it("builds a still frame on YouTube's thumbnail host", () => {
    expect(thumbnailUrlFor(VIDEO)).toBe(`https://img.youtube.com/vi/${VIDEO}/mqdefault.jpg`);
  });

  it('re-validates the id rather than trusting the caller', () => {
    // The same rule `embedUrlFor` follows: this string is fetched by the browser, and the
    // value in it started life as a paste.
    expect(thumbnailUrlFor('../../evil')).toBeNull();
    expect(thumbnailUrlFor(PLAYLIST)).toBeNull();
    expect(thumbnailUrlFor(null)).toBeNull();
    expect(thumbnailUrlFor(undefined)).toBeNull();
    expect(thumbnailUrlFor('')).toBeNull();
  });
});
