// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer, type Bytes } from 'node:buffer';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:https';
import { selfSignedIdentity } from './selfSigned';
import { sleep, type Signal } from './wait';

/**
 * A stub HTTPS server inside this resource (MICA-304): what micaOS sends over HTTP, received
 * and kept, so a scenario can say what arrived — method, path, headers, body — and choose
 * what the far end answers.
 *
 * In-process rather than a sidecar. FXServer's server-side JavaScript is Node, so this is a
 * `https.createServer` on 127.0.0.1 at a port the kernel picks, started and closed by the
 * scenario that uses it; the box's wrapper has nothing to start, stop or clean up, and micaOS
 * reads every URL it posts to from a convar on each call, so the scenario points it here with
 * `SetConvar` once the port is known.
 *
 * TLS because micaOS refuses plain HTTP everywhere it makes a call. The certificate is
 * self-signed (`selfSigned.ts`), and Node's fetch would refuse it; `trustAnyCertificate`
 * turns that check off for the process, through `NODE_TLS_REJECT_UNAUTHORIZED`, which Node's
 * TLS client reads on every connection, and only while a sink is open. That is a
 * process-wide switch on a server nobody plays on, and it is put back as it was afterwards.
 *
 * Nothing here is silent when it cannot work. A sink that cannot listen throws; one that
 * listens but that this resource's own `fetch` cannot reach (TLS refused, a sandbox) throws
 * from `probe`, before any scenario points micaOS at it. A scenario that uses one therefore
 * fails, never passes on an empty request list.
 *
 * Pure apart from Node: no FiveM global is touched, so `integrationHttpSink.test.ts` runs the
 * same code against real `fetch` and micaOS's real HTTP modules.
 */

/** What arrived, one per request. Header names lower-cased, as Node gives them. */
export interface SinkRequest {
  seq: number;
  method: string;
  /** The path and query, exactly as requested. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Bytes;
  /** The body went past `MAX_BODY` and was cut there. */
  truncated: boolean;
}

/** How the sink answers one request: a status (and JSON), or a hang-up with no answer at all. */
export type SinkReply =
  { status: number; json?: unknown; headers?: Record<string, string> } | { drop: true };

export type Responder = (request: SinkRequest) => SinkReply;

/** Far more than anything micaOS sends: a photo is capped well under it. */
const MAX_BODY = 8 * 1024 * 1024;

/** The sink's own reachability check. Answered, never recorded. */
const PROBE_PATH = '/__itx/probe';

/** The minimal shapes of Node's web globals used here, declared as `server/lib` does. */
declare const fetch: (
  url: string,
  init?: { method?: string }
) => Promise<{ status: number; text(): Promise<string> }>;
declare const process: { env: Record<string, string | undefined> };

const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  // Node's fetch says `fetch failed` and puts what happened on `cause`.
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
};

const flatten = (headers: IncomingMessage['headers']): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
};

export class HttpSink {
  private readonly seen: SinkRequest[] = [];
  private next = 0;
  private responder: Responder = () => ({ status: 404 });

  constructor(
    private readonly server: Server,
    /** `https://127.0.0.1:<port>`, no trailing slash. */
    readonly origin: string
  ) {}

  /** How every request from now on is answered. */
  respond(responder: Responder): void {
    this.responder = responder;
  }

  /** A position to read from: every request that arrives after this has a `seq` at or above it. */
  mark(): number {
    return this.next;
  }

  since(mark: number): SinkRequest[] {
    return this.seen.filter((request) => request.seq >= mark);
  }

  /**
   * The first request at or after `mark` that `match` accepts, waiting up to `timeoutMs`. Throws
   * with what *did* arrive, which is the diagnosis when the expected one never comes.
   */
  async waitFor(
    mark: number,
    match: (request: SinkRequest) => boolean,
    timeoutMs: number,
    signal: Signal,
    what: string
  ): Promise<SinkRequest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.since(mark).find(match);
      if (found) return found;
      if (signal.aborted) throw new Error(`gave up waiting for ${what}`);
      if (Date.now() >= deadline) {
        const arrived = this.since(mark)
          .map((request) => `${request.method} ${request.path}`)
          .join(', ');
        throw new Error(
          `no ${what} reached the sink within ${timeoutMs} ms` +
            (arrived ? `; it received: ${arrived}` : '; it received nothing')
        );
      }
      await sleep(50);
    }
  }

  /** Answer one request. Every socket error is caught: a hang-up is the client's business. */
  handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    request.on('error', () => {});
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) truncated = true;
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const path = request.url ?? '';
        if (path === PROBE_PATH) {
          response.writeHead(204, { Connection: 'close' });
          response.end();
          return;
        }
        const received: SinkRequest = {
          seq: this.next++,
          method: request.method ?? '',
          path,
          headers: flatten(request.headers),
          body: Buffer.concat(chunks),
          truncated
        };
        this.seen.push(received);

        let reply: SinkReply;
        try {
          reply = this.responder(received);
        } catch (error) {
          reply = {
            status: 500,
            json: { error: `the sink's responder threw: ${reasonOf(error)}` }
          };
        }
        if ('drop' in reply) {
          request.socket.destroy();
          return;
        }
        const headers: Record<string, string> = { Connection: 'close', ...reply.headers };
        if (reply.json !== undefined) headers['Content-Type'] = 'application/json';
        response.writeHead(reply.status, headers);
        response.end(reply.json === undefined ? '' : JSON.stringify(reply.json));
      } catch {
        request.socket.destroy();
      }
    });
  }

  /**
   * This resource's own `fetch` to the sink, which has to answer before micaOS is pointed at it.
   * Throws when it does not, naming why: a refused certificate here would be a refused
   * certificate for micaOS too, and every scenario after it would read as micaOS's failure.
   */
  async probe(): Promise<void> {
    let status: number;
    try {
      status = (await fetch(`${this.origin}${PROBE_PATH}`)).status;
    } catch (error) {
      throw new Error(
        `the HTTPS sink at ${this.origin} is listening but this resource's own fetch cannot ` +
          `reach it (${reasonOf(error)}), so micaOS's could not either`,
        { cause: error }
      );
    }
    if (status !== 204) {
      throw new Error(`the HTTPS sink's probe answered ${status}, not 204`);
    }
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

/** Listen on 127.0.0.1 at a port the kernel picks. Throws, naming why, when it cannot. */
export const startSink = async (): Promise<HttpSink> => {
  const identity = selfSignedIdentity();
  let sink: HttpSink | null = null;
  const server = createServer(identity, (request, response) => {
    if (sink) sink.handle(request, response);
    else request.socket.destroy();
  });
  // A client that hangs up mid-handshake or mid-request is not the sink failing.
  server.on('tlsClientError', () => {});
  server.on('clientError', () => {});

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (error) =>
      reject(
        new Error(`the HTTPS sink could not listen on 127.0.0.1: ${reasonOf(error)}`, {
          cause: error
        })
      )
    );
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error(`the HTTPS sink is listening at '${String(address)}', not a port`));
    });
  });
  server.on('error', () => {});
  sink = new HttpSink(server, `https://127.0.0.1:${port}`);
  return sink;
};

const TLS_CHECK = 'NODE_TLS_REJECT_UNAUTHORIZED';

/**
 * Let Node's TLS client accept the sink's self-signed certificate, and answer how to put it
 * back. Node reads the variable on every new connection, so it reaches micaOS's `fetch` as
 * well as this resource's: it is the process's environment, not a resource's.
 */
export const trustAnyCertificate = (): (() => void) => {
  const previous = process.env[TLS_CHECK];
  process.env[TLS_CHECK] = '0';
  return () => {
    if (previous === undefined) delete process.env[TLS_CHECK];
    else process.env[TLS_CHECK] = previous;
  };
};

/**
 * A sink for the length of `run`: listening, probed, and closed afterwards with the TLS check
 * put back, however `run` ends.
 */
export const withSink = async <T>(run: (sink: HttpSink) => Promise<T>): Promise<T> => {
  const restore = trustAnyCertificate();
  let sink: HttpSink | null = null;
  try {
    sink = await startSink();
    await sink.probe();
    return await run(sink);
  } finally {
    try {
      if (sink) await sink.close();
    } finally {
      restore();
    }
  }
};

// ─── multipart/form-data ───────────────────────────────────────────────────────────────────

export interface FormPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Bytes;
}

const CRLF = Buffer.from('\r\n', 'utf8');
const BLANK_LINE = Buffer.from('\r\n\r\n', 'utf8');

const dispositionParam = (value: string, param: string): string | null => {
  const match = new RegExp(`;\\s*${param}="([^"]*)"`, 'i').exec(value);
  return match ? match[1] : null;
};

/**
 * The parts of a `multipart/form-data` body, as RFC 7578 lays them out: each after a
 * `--<boundary>` line, headers, a blank line, then the bytes up to the CRLF before the next
 * boundary. Throws on anything that is not that shape, since a part this misread would be an
 * assertion about the wrong bytes.
 */
export const parseMultipart = (contentType: string | undefined, body: Bytes): FormPart[] => {
  const declared = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(
    contentType ?? ''
  );
  if (!declared) throw new Error(`the body is '${contentType ?? 'untyped'}', not multipart`);
  const boundary = declared[1] ?? declared[2];
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`, 'utf8');

  const parts: FormPart[] = [];
  let at = body.indexOf(delimiter);
  if (at < 0) throw new Error('the multipart body holds no boundary');
  for (;;) {
    at += delimiter.length;
    // `--` straight after a boundary closes the body.
    if (body[at] === 0x2d && body[at + 1] === 0x2d) break;
    if (body.indexOf(CRLF, at) !== at)
      throw new Error('a multipart boundary is not followed by CRLF');
    at += CRLF.length;

    const headerEnd = body.indexOf(BLANK_LINE, at);
    if (headerEnd < 0) throw new Error('a multipart part has no end to its headers');
    const headers: Record<string, string> = {};
    for (const line of body.subarray(at, headerEnd).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0)
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const start = headerEnd + BLANK_LINE.length;
    const end = body.indexOf(nextDelimiter, start);
    if (end < 0) throw new Error('a multipart part is never closed by a boundary');

    const disposition = headers['content-disposition'] ?? '';
    if (!/^form-data\b/i.test(disposition)) {
      throw new Error(`a multipart part's disposition is '${disposition}', not form-data`);
    }
    parts.push({
      name: dispositionParam(disposition, 'name') ?? '',
      filename: dispositionParam(disposition, 'filename'),
      contentType: headers['content-type'] ?? null,
      data: body.subarray(start, end)
    });
    at = end + CRLF.length;
  }
  return parts;
};
