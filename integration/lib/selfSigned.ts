// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A throwaway TLS identity for the HTTP sink (MICA-304), made in this process.
 *
 * Every outbound call micaOS makes refuses anything but `https://` — the Discord webhook, the
 * image host, the add-on catalog — so a sink they will talk to has to speak TLS, and so it
 * needs a certificate. Node can make a key pair but has no API that makes a certificate, and
 * the alternatives are worse: a key committed to the repository, or a file the wrapper writes
 * and FXServer's filesystem sandbox may refuse to let this resource read. So the certificate
 * is written here, as DER, by hand: a self-signed P-256 certificate for 127.0.0.1 and
 * `localhost`, valid from an hour ago to a day from now, never stored anywhere.
 *
 * `integrationHttpSink.test.ts` parses what this makes with Node's own `X509Certificate`,
 * checks the signature against the key and the address against the name, so a byte out of
 * place here fails there rather than on hoth.
 */

type Der = number[];

const lengthOf = (n: number): Der => {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
};

const tlv = (tag: number, content: readonly number[]): Der => [
  tag,
  ...lengthOf(content.length),
  ...content
];

const sequence = (...parts: Der[]): Der => tlv(0x30, parts.flat());
const set = (...parts: Der[]): Der => tlv(0x31, parts.flat());

const oid = (dotted: string): Der => {
  const arcs = dotted.split('.').map(Number);
  const body = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      chunk.unshift(0x80 | (rest & 0x7f));
    }
    body.push(...chunk);
  }
  return tlv(0x06, body);
};

/** A positive INTEGER, minimally encoded: a leading zero only when the high bit is set. */
const integer = (bytes: readonly number[]): Der =>
  tlv(0x02, (bytes[0] ?? 0) & 0x80 ? [0, ...bytes] : [...bytes]);

const utf8 = (text: string): Der => tlv(0x0c, [...Buffer.from(text, 'utf8')]);

const utcTime = (at: Date): Der => {
  const two = (n: number): string => String(n).padStart(2, '0');
  const text =
    two(at.getUTCFullYear() % 100) +
    two(at.getUTCMonth() + 1) +
    two(at.getUTCDate()) +
    two(at.getUTCHours()) +
    two(at.getUTCMinutes()) +
    two(at.getUTCSeconds()) +
    'Z';
  return tlv(
    0x17,
    [...text].map((c) => c.charCodeAt(0))
  );
};

const bitString = (bytes: readonly number[]): Der => tlv(0x03, [0, ...bytes]);
const octetString = (bytes: readonly number[]): Der => tlv(0x04, bytes);
const explicit = (n: number, content: Der): Der => tlv(0xa0 | n, content);

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const SUBJECT_ALT_NAME = '2.5.29.17';

const pem = (label: string, der: readonly number[]): string => {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
};

export interface TlsIdentity {
  /** PKCS#8, PEM. */
  key: string;
  /** X.509 v3, PEM, self-signed. */
  cert: string;
}

/** A fresh key and a self-signed certificate naming 127.0.0.1 and `localhost`. */
export const selfSignedIdentity = (now: Date = new Date()): TlsIdentity => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // Positive, eight bytes, and its first byte neither zero nor high-bit: minimal as it stands.
  const serial = [...randomBytes(8)];
  serial[0] = (serial[0] & 0x3f) | 0x40;

  const name = sequence(set(sequence(oid(COMMON_NAME), utf8('mica-integration sink'))));
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const altNames = sequence(
    tlv(0x87, [127, 0, 0, 1]), // [7] iPAddress
    tlv(0x82, [...Buffer.from('localhost', 'utf8')]) // [2] dNSName
  );

  const tbs = sequence(
    explicit(0, integer([2])), // v3
    integer(serial),
    algorithm,
    name,
    sequence(
      utcTime(new Date(now.getTime() - 60 * 60_000)),
      utcTime(new Date(now.getTime() + 24 * 60 * 60_000))
    ),
    name,
    [...publicKey.export({ type: 'spki', format: 'der' })],
    explicit(3, sequence(sequence(oid(SUBJECT_ALT_NAME), octetString(altNames))))
  );

  const signature = sign('sha256', Buffer.from(tbs), privateKey);
  const certificate = sequence(tbs, algorithm, bitString([...signature]));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', certificate)
  };
};
