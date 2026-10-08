// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { imageHostOrigin } from '../lib/mediaHost';
import { shellContract } from '@mica/shared/contracts/shell';

/**
 * Where hosted photos are drawn from, so the add-on sandbox can let them in. MICA-243.
 *
 * A `core: false` add-on runs under a `default-src 'none'` CSP whose `img-src` is `data:`,
 * `blob:` and its own `networkHosts` (`web/src/shell/addon/srcdoc.ts`). A photo on an image
 * host is an `https:` URL, so without this an add-on handed one draws a broken image. The
 * shell asks once and adds exactly this origin to `img-src` — not `connect-src`, not
 * `media-src` — so an add-on can show a hosted photo and cannot `fetch` the host.
 *
 * The answer is the origin and nothing else: `https://<host>`, from `mica_media_image_host`
 * or the upload URL's host. The upload URL's path and `mica_media_upload_header` — the API
 * key — never leave the server; see `lib/mediaHost.ts`.
 *
 * On the `shell` service, beside `sourceUrl` and `capabilities`, for the same reason they are:
 * a property of the server, identical for every caller, read from no payload.
 */
const app = new ServiceEndpoint<never, typeof shellContract>('shell', null, {
  contract: shellContract,
  // The shell boots on whichever device is open (MICA-264).
  devices: ['phone', 'tablet'],
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

app.registerEvent('imageHost', async () => ({ origin: imageHostOrigin() }));
