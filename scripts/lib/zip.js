// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A zip writer with no dependency behind it.
 *
 * The release zip (MICA-220) is a few hundred files and under ten megabytes, and the
 * format's plain case -- one local header per file, a central directory, an end record --
 * is about a hundred lines. A package for it would be one more thing in the supply chain
 * of the artifact this repo signs, and the `zip` binary is on a CI runner but not on every
 * developer's machine, which would make `pnpm verify`'s pack gate depend on the host.
 *
 * What it does not do, on purpose: ZIP64 (nothing here approaches four gigabytes or
 * sixty-five thousand entries, and it throws rather than silently overflowing a field),
 * directory entries (every extractor creates the parents of a file), and unix permissions
 * (a resource is read by FXServer, never executed by a shell).
 *
 * Output is a function of its input alone. Entries are sorted by path and every entry
 * carries the one timestamp the caller supplies, so the same tree packed twice is the same
 * bytes -- which is what makes a checksum in `SHA256SUMS` something a second machine can
 * reproduce rather than merely re-download.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;

/** "Version needed to extract" 2.0: deflate, which every extractor since 1993 reads. */
const VERSION = 20;
/** General-purpose flag bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

/**
 * MS-DOS date and time, the only timestamp the base format carries. Two-second
 * resolution, and the year is an offset from 1980 in seven bits.
 *
 * Read as UTC rather than local time so the bytes do not depend on the packing machine's
 * timezone; the format itself says nothing about which zone a stamp is in.
 */
const dosStamp = (date) => {
  const year = date.getUTCFullYear();
  if (!Number.isFinite(year) || year < 1980 || year > 2107) {
    throw new RangeError(`zip: a DOS timestamp cannot carry the year ${year}`);
  }
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
};

const assertPath = (path, seen) => {
  if (typeof path !== 'string' || path.length === 0) throw new Error('zip: an entry has no path');
  if (path.startsWith('/') || path.includes('\\')) {
    throw new Error(`zip: entry paths are relative and use '/': ${path}`);
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`zip: entry path has an empty, '.' or '..' segment: ${path}`);
  }
  if (seen.has(path)) throw new Error(`zip: duplicate entry: ${path}`);
  seen.add(path);
};

/**
 * @param {Array<{ path: string, data: Buffer | string }>} entries
 * @param {{ mtime: Date }} options the one timestamp every entry carries
 * @returns {Buffer} the archive
 */
export function createZip(entries, { mtime }) {
  const { time, day } = dosStamp(mtime);
  const seen = new Set();
  for (const { path } of entries) assertPath(path, seen);
  if (entries.length > MAX_ENTRIES) {
    throw new RangeError(`zip: ${entries.length} entries needs ZIP64, which this does not write`);
  }

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { path, data } of sorted) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const name = Buffer.from(path, 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store what deflate would only grow: an already-compressed asset, an empty file.
    const body = deflated.length < raw.length ? deflated : raw;
    const method = body === deflated ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(raw);

    if (raw.length > MAX_BYTES || offset > MAX_BYTES) {
      throw new RangeError(`zip: ${path} needs ZIP64, which this does not write`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const directorySize = centrals.reduce((total, chunk) => total + chunk.length, 0);
  if (offset > MAX_BYTES || directorySize > MAX_BYTES) {
    throw new RangeError('zip: the archive needs ZIP64, which this does not write');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}
