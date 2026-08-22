import { test, expect } from '@playwright/test';
import { addOnFrame } from './support/addon';

/**
 * Every notification route, checked to actually land.
 *
 * All of these were broken. `NotificationShade` passed `deep_link` whole to `openApp`,
 * which registered a resident app called `"mail/12"` — no component resolves that, and
 * `Shell` skips `<Home>` whenever the current app is not home, so the phone went blank
 * with no way back. Blabber had no `useDeepLink` at all, so its three notification kinds
 * could not land even once parsing worked.
 *
 * The assertion is deliberately "the right screen is showing", not "the store changed".
 * A link that resolves and renders nothing is the exact failure being fixed here.
 */

const openShade = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Open notification shade' }).click();
  await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toBeVisible();
};

test('a standalone shade notification opens the app it points at', async ({ page }) => {
  await page.goto('/');
  await openShade(page);

  // Settings has one fixture, so it renders as a standalone row rather than a group.
  await page.getByText('Developer Tools').first().click();

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toBeHidden();
});

test('a notification inside a group opens too', async ({ page }) => {
  // A separate code path from the standalone row, and the one a busy phone actually
  // shows: three Messages fixtures collapse into a group whose header expands rather
  // than navigates.
  await page.goto('/');
  await openShade(page);

  await page
    .getByText(/^messages$/i)
    .first()
    .click();

  // Trevor, deliberately not the newest row. The group header previews the latest item
  // (Ursula), so picking a row *behind* the preview means the assertion below cannot pass
  // by the header having been clicked. It also has to be a row whose name differs from
  // the one `conversationId=1` resolves to — the earlier version of this test clicked
  // "Sarah Connor" and asserted it landed on "Ursula (Crazy Ex)", which is the bug
  // written down as the expectation.
  await page.getByText('Trevor Philips').click();

  // Shade first, and not for tidiness: a notification row titles itself with an `<h4>`,
  // so while the shade is still animating out there are two headings named "Trevor
  // Philips" and the heading assertion is a strict-mode violation rather than a wait.
  // The previous version of this test never hit that only because the row name and the
  // conversation name disagreed — the fixture bug was hiding this one.
  await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toBeHidden();

  // The name on the row is the name on the screen. Landing on the inbox would mean the
  // props were dropped in transit; landing on someone else means the fixture is lying.
  await expect(page.getByRole('heading', { name: 'Trevor Philips' })).toBeVisible();
});

test('a mail notification opens the email, not the inbox', async ({ page }) => {
  // The quieter half of the same fixture bug. Messages pointed at the wrong conversation,
  // which at least rendered something; mail pointed at `mailId` 5 and 6 against three
  // fixture rows, so `useDeepLink` returned false, was retried forever, and Mail sat on
  // the inbox. Asserting the app opened would have passed throughout.
  await page.goto('/');
  await openShade(page);

  await page
    .getByText(/^mail$/i)
    .first()
    .click();
  await page.getByText('Email from Fleeca Bank').last().click();

  await expect(page.getByText('Account Statement Available').first()).toBeVisible();
  await expect(page.getByText(/Balance: \$15,450\.00/)).toBeVisible();
});

test('a toast follows the deep link its push declared', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          action: 'appEvent',
          data: {
            // The envelope names Mail and the link names Notes, deliberately. Both routes
            // led to the same screen while `app` and the link agreed, so the assertion
            // could not tell them apart — and `parseAppEventEnvelope` was dropping
            // `deepLink` entirely, which that version of this test passed straight through.
            // Landing on Mail here means the payload fallback ran.
            app: 'mail',
            event: 'received',
            payload: { some_internal_id: 999 },
            at: Date.now(),
            deepLink: 'notes',
            notify: { type: 'info', title: 'New mail', message: 'Tap to read' }
          }
        }
      })
    );
  });

  await page.getByText('New mail').click();
  await expect(addOnFrame(page, 'notes').getByRole('heading', { name: 'Notes' })).toBeVisible();
});

test('an unresolvable link leaves the phone where it was', async ({ page }) => {
  await page.goto('/');
  // The shape the server used to write. It must be a no-op, not a blank screen.
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          action: 'appEvent',
          data: {
            app: 'mail',
            event: 'received',
            payload: {},
            at: Date.now(),
            deepLink: 'mail/12',
            notify: { type: 'info', title: 'Broken link', message: 'Tap me' }
          }
        }
      })
    );
  });

  await page.getByText('Broken link').click();
  // Falls back to opening the app bare rather than navigating nowhere. The property that
  // matters is that the screen still renders something — a blank phone with no back
  // affordance is what the unparsed string used to produce.
  await expect(page.getByRole('heading', { name: 'Mail' })).toBeVisible();
});

test('a link to an app that is not installed leaves the phone where it was', async ({ page }) => {
  await page.goto('/');
  // The realistic case, not a synthetic one: an add-on is uninstalled while a notification
  // pointing at it is still on the phone. The link parses perfectly — it is well-formed —
  // and there is simply nothing behind the id. `openApp`'s guard is the only thing between
  // that and a blank screen with no back affordance.
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          action: 'appEvent',
          data: {
            app: 'mail',
            event: 'received',
            payload: {},
            at: Date.now(),
            deepLink: 'not_a_real_app?id=1',
            notify: { type: 'info', title: 'Gone app', message: 'Tap me' }
          }
        }
      })
    );
  });

  await page.getByText('Gone app').click();
  await expect(page.getByRole('heading', { name: 'gPhone' })).toBeVisible();
});
