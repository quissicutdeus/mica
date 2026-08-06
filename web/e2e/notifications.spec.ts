import { test, expect } from '@playwright/test';

test.describe('Interactive Toast Notifications E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('handles incoming message toast with interactive inline reply input box', async ({
    page
  }) => {
    // Emit receiveMessage NUI action
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'receiveMessage',
            data: {
              conversation_id: 1,
              senderName: 'Trevor Philips',
              message: 'Meet me at Sandy Shores airfield right now!',
              avatar: undefined
            }
          }
        })
      );
    });

    // Check toast banner appears with sender name and message snippet
    await expect(page.locator('text=Trevor Philips').first()).toBeVisible();
    await expect(page.locator('text=Meet me at Sandy Shores airfield right now!')).toBeVisible();

    // Verify inline reply input field exists and focus to type reply
    const replyInput = page.locator('input[placeholder="Reply..."]');
    await expect(replyInput).toBeVisible();
    await replyInput.fill('On my way Trevor!');

    // Click Send reply button inside toast using direct event dispatch
    const sendBtn = page.locator('button[aria-label="Send reply"]');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.dispatchEvent('click');

    // Verify success toast appears confirming reply sent
    await expect(page.locator('text=Reply sent')).toBeVisible();
  });

  test('handles contact share request toast with standardized Accept and Decline actions', async ({
    page
  }) => {
    // Emit shareContact NUI action
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'shareContact',
            data: {
              firstname: 'Franklin',
              lastname: 'Clinton',
              phone: '555-0177'
            }
          }
        })
      );
    });

    // Check contact share toast banner appears
    await expect(page.locator('text=Contact Shared')).toBeVisible();
    await expect(page.locator('text=Franklin Clinton (555-0177)')).toBeVisible();

    // Verify standardized Accept and Decline buttons are present
    const acceptBtn = page.locator('button', { hasText: 'Accept' }).first();
    const declineBtn = page.locator('button', { hasText: 'Decline' }).first();
    await expect(acceptBtn).toBeVisible();
    await expect(declineBtn).toBeVisible();

    // Click Accept button to add contact using direct event dispatch
    await acceptBtn.dispatchEvent('click');

    // Verify confirmation toast is displayed
    await expect(page.locator('text=Contact added to address book')).toBeVisible();
  });

  test('handles incoming call toast with standardized Accept and Decline actions', async ({
    page
  }) => {
    // Emit incoming call NUI action
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'callStatus',
            data: {
              status: 'incoming',
              name: 'Lester Crest',
              number: '555-0155'
            }
          }
        })
      );
    });

    // Check incoming call toast banner displays with name and number
    await expect(page.locator('text=Incoming Call')).toBeVisible();
    await expect(page.locator('text=Lester Crest (555-0155)')).toBeVisible();

    // Verify standardized Accept and Decline action buttons exist
    const acceptBtn = page.locator('button', { hasText: 'Accept' }).first();
    const declineBtn = page.locator('button', { hasText: 'Decline' }).first();
    await expect(acceptBtn).toBeVisible();
    await expect(declineBtn).toBeVisible();
  });

  test('handles incoming email toast notification', async ({ page }) => {
    // Emit receiveMail NUI action
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'receiveMail',
            data: {
              sender: 'Fleeca Bank',
              subject: 'Your Monthly Statement is Ready'
            }
          }
        })
      );
    });

    // Check email toast banner displays sender and subject line
    await expect(page.locator('text=New Email: Fleeca Bank')).toBeVisible();
    await expect(page.locator('text=Your Monthly Statement is Ready')).toBeVisible();
  });

  test('clicking message toast area opens Messages app deep link', async ({ page }) => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'receiveMessage',
            data: {
              conversation_id: 1,
              senderName: 'Trevor Philips',
              message: 'Check airfield!'
            }
          }
        })
      );
    });

    const toastCard = page.locator('.pointer-events-auto', { hasText: 'Trevor Philips' }).first();
    await expect(toastCard).toBeVisible();
    await toastCard.evaluate((el) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    );

    // Verify Messages conversation view opens
    await expect(page.locator('#messages-container')).toBeVisible();
  });

  test('clicking email toast area opens Mail app deep link', async ({ page }) => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'receiveMail',
            data: {
              id: 1,
              sender: 'Fleeca Bank',
              subject: 'Monthly Statement Available'
            }
          }
        })
      );
    });

    const toastCard = page
      .locator('.pointer-events-auto', { hasText: 'New Email: Fleeca Bank' })
      .first();
    await expect(toastCard).toBeVisible();
    await toastCard.evaluate((el) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    );

    // Verify Mail app opens
    await expect(page.locator('h1').first()).toBeVisible();
  });

  test('clicking shared contact toast body accepts contact without navigating', async ({
    page
  }) => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'shareContact',
            data: {
              firstname: 'Franklin',
              lastname: 'Clinton',
              phone: '555-0177'
            }
          }
        })
      );
    });

    const toastCard = page.locator('.pointer-events-auto', { hasText: 'Contact Shared' }).first();
    await expect(toastCard).toBeVisible();
    await toastCard.dispatchEvent('click');

    // Verify confirmation toast appears
    await expect(page.locator('text=Contact added to address book')).toBeVisible();
  });

  test('shows error toast when accepting shared contact with missing mandatory name/phone', async ({
    page
  }) => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            action: 'shareContact',
            data: {
              firstname: '',
              phone: ''
            }
          }
        })
      );
    });

    const acceptBtn = page.locator('button', { hasText: 'Accept' }).first();
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.dispatchEvent('click');

    await expect(
      page.locator('text=Cannot add contact: missing required name or phone number')
    ).toBeVisible();
  });

  /**
   * This test used to dispatch `{ action: 'pushNotification' }`, which is not a route
   * the phone has ever had — the name appears nowhere in `web/src`, `shared/`, `client/`
   * or `server/`. `nuiMessages.ts` ignores an unknown action, so the test asserted on a
   * toast that could not arrive, and it had never passed since the day it was written.
   *
   * That is precisely the failure AGENTS.md §8 describes: a NUI action with no layer
   * behind it does nothing and says nothing. The mock registry answers by action name and
   * hides it in the browser; here there was not even a mock, only a name.
   *
   * The real contract is one generic envelope, `appEvent` from `shared/appEvents.ts`,
   * carrying the target app and an optional `notify` block. So this now drives the route
   * that actually exists, and covers both halves of what the name claims: the shade opens
   * from the status bar, and a pushed event raises a toast.
   */
  test('notification shade opens via gesture and displays persistent notifications', async ({
    page
  }) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();

    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await expect(shade).toBeVisible();
    await expect(shade.getByText('Sarah Connor')).toBeVisible();

    // The home indicator collapses the shade rather than going home while it is open.
    await page.getByRole('button', { name: 'Collapse notifications' }).click();
    await expect(shade).toBeHidden();
  });

  /** Push an `AppEventEnvelope` down the one generic route the shell registers. */
  const pushAppEvent = (page: import('@playwright/test').Page, app: string, title: string) =>
    page.evaluate(
      ({ app, title }) => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              action: 'appEvent',
              data: {
                app,
                event: 'mention',
                payload: { id: 99 },
                at: Date.now(),
                notify: { type: 'info', title, message: 'Check out this post' }
              }
            }
          })
        );
      },
      { app, title }
    );

  test('an app event with a notify block raises a toast', async ({ page }) => {
    // `mail` is core and declares `notifications`, so it is installed and permitted.
    await pushAppEvent(page, 'mail', 'You have new mail');
    await expect(page.getByText('You have new mail')).toBeVisible();
  });

  test('an app that is not installed does not get to interrupt the player', async ({ page }) => {
    // The toast is gated on `getManifest(app)` finding a manifest that declares
    // `notifications`. Blabber declares it but is `core: false`, so in a fresh session it
    // is not installed and there is no manifest to consult.
    //
    // Worth asserting rather than assuming: the gate is the only thing keeping an add-on
    // the player removed — or never installed — from raising toasts at them, and nothing
    // else in the suite covers the negative case. The data half still flows either way,
    // deliberately; §7 says permissions are a disclosure, not a sandbox.
    await pushAppEvent(page, 'blabber', '@michael mentioned you');
    await expect(page.getByText('@michael mentioned you')).toHaveCount(0);
  });
});
