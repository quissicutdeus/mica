import fs from 'node:fs';
import path from 'node:path';
import type { Route } from '@playwright/test';
import { test, expect } from './support/test';
import { addOnFrame, dismissToasts } from './support/addon';
import { DEV_BASE } from './support/devAddon';

/**
 * An add-on built once, against SDK contract version 1, and never rebuilt (MICA-462).
 *
 * Types guard what an add-on compiles against. Nothing else guards what an add-on already
 * published by somebody outside this repo does at runtime, and every in-tree add-on is
 * rebuilt from source on each run, so a change to the wire format between shell and frame
 * (`sdk/host/iframe/messages.ts`: `hello`, `hydrate`, `call`, `reply`, `subscribe`, `push`)
 * passes every suite while breaking all of them. `fixtures/frozen-addon/frozenprobe.js` is
 * that other add-on: built from the sha named in `RECIPE.md`, committed as bytes, pinned by
 * hash in `web/src/lib/frozenAddon.test.ts`. This spec boots it on every run.
 *
 * **Route in.** The same loopback route as `dev-addon.spec.ts` (`?addonDev=`), with
 * `page.route` standing in for the author's server and the committed `entry.json` and bundle
 * as its two files. The Store's catalog route is not available: it needs `mica_addon_hosts`
 * to trust a host, the mock transport answers none, and nothing in the e2e build sets
 * `VITE_MICA_ADDON_HOSTS`. The dev route registers a non-bundled add-on with a grant of its
 * own entry's `permissions`, which is the point: the grant belongs to the fixture and not to
 * an in-tree manifest someone may trim later. What the route adds on top (a strip above the
 * frame) is not what is under test.
 *
 * **What it drives**, each through the real frame and the real shell:
 *  - hello and hydrate: the frame mounts only after `hydrate` arrives, so its first paint is
 *    the proof both messages crossed.
 *  - a declared call answered: `notifications.load()` resolves, and the `unreadCount` store
 *    it subscribed to is pushed its first value.
 *  - an undeclared call refused, twice. `entry.json` grants `notifications` only, while the
 *    bundle also asks for `contacts`. Its own hook guard refuses `useContacts()` from the
 *    hydrated permissions, caught in the bundle. That guard is frozen in the bytes and cannot
 *    regress, so a second case has the bundle skip it and post a hand-built `call` message:
 *    the `reply` the SHELL sends back (`ok: false`, `AppPermissionError`, the permission and
 *    hook named) is what is asserted. Neither throws an uncaught error (the shared fixture
 *    fails a test on an `Uncaught` line).
 *  - notifications and badge: the frame sends one, the shell shows the toast, and the unread
 *    count the shell keeps for the add-on's id is pushed back into the frame. A non-bundled
 *    add-on has no `badgeStore`, so that count is the only badge it has.
 *
 * What this cannot show: FiveM's CEF 103 (the `cef-floor` project is a Chromium 103 standing
 * in for it), the NUI round trip, or any add-on other than this one.
 */

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/frozen-addon');
const ENTRY = fs.readFileSync(path.join(FIXTURE, 'entry.json'), 'utf8');
const BUNDLE = fs.readFileSync(path.join(FIXTURE, 'frozenprobe.js'), 'utf8');
const ID = 'frozenprobe';
const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

test.describe('a frozen add-on built against contract version 1', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(`${DEV_BASE}**`, (route: Route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/mica-dev.json') {
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: ENTRY
        });
      }
      if (pathname === '/frozenprobe.js') {
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'text/javascript' },
          body: BUNDLE
        });
      }
      return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
    });
    await page.goto(`/?addonDev=${encodeURIComponent(DEV_BASE)}`);
    await expect(page.getByTestId('mica-dev-addon')).toBeVisible();
  });

  test('says hello, is hydrated, and has a declared call answered', async ({ page }) => {
    const frame = addOnFrame(page, ID);
    // Mounted, so `hydrate` arrived after the `hello` it answers.
    await expect(frame.getByTestId('booted')).toBeVisible();
    // `load` is a call the grant covers: its reply resolved the promise the bundle awaited.
    await expect(frame.getByTestId('loaded')).toHaveText('loaded');
    // And a subscription's first push: the store would read `unread: undefined` without it.
    await expect(frame.getByTestId('unread')).toHaveText('unread: 0');
  });

  test('refuses a call the grant does not cover, as an answer', async ({ page }) => {
    const frame = addOnFrame(page, ID);
    await expect(frame.getByTestId('loaded')).toHaveText('loaded');
    await dismissToasts(page);

    await frame.getByTestId('contacts').click();
    // A refusal that reached the bundle as a rejected reply. If the call had been let
    // through, the bundle would print `allowed`; if it had been dropped, nothing at all.
    await expect(frame.getByTestId('contacts-answer')).toHaveText('refused: AppPermissionError');
  });

  test('is refused by the shell when it skips its own guard and calls on the wire', async ({
    page
  }) => {
    const frame = addOnFrame(page, ID);
    await expect(frame.getByTestId('loaded')).toHaveText('loaded');
    await dismissToasts(page);

    // The bundle posts a hand-built `call` for `contacts` (not granted) and prints the
    // `reply` the shell sends back: its kind, `ok`, and the error's name, permission and hook.
    // This is the shell's own refusal, which no change to the bundle's hooks can move.
    await frame.getByTestId('raw').click();
    await expect(frame.getByTestId('raw-answer')).toHaveText(
      'reply | false | AppPermissionError | contacts | useContacts'
    );
  });

  test('reaches the shell with a notification, and counts it as the add-on’s badge', async ({
    page
  }) => {
    const frame = addOnFrame(page, ID);
    await expect(frame.getByTestId('unread')).toHaveText('unread: 0');
    await dismissToasts(page);

    await frame.getByTestId('notify').click();
    await expect(frame.getByTestId('sent')).toHaveText('sent');
    // The shell's own toast layer, in the parent document: the call crossed the wall.
    await expect(page.getByText('sent from a frozen bundle')).toBeVisible();
    // The count the shell keeps under the add-on's id came back down the wire.
    await expect(frame.getByTestId('unread')).toHaveText('unread: 1');
  });
});
