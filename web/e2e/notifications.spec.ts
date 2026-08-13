import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Mirrors `web/src/shell/state/display.ts`'s `PHONE_WIDTH`/`SHADE_DRAG_REVEAL_DISTANCE`
 * rather than importing them — `display.spec.ts` establishes the same convention for
 * `PHONE_WIDTH`/`PHONE_HEIGHT`, since a Playwright spec drives the built page rather than
 * importing app source.
 */
const PHONE_WIDTH = 400;
const SHADE_DRAG_REVEAL_DISTANCE = 850;

/** The frame's rendered rectangle, after the entrance fly-in has landed. See `display.spec.ts`. */
const frameBox = async (page: Page) => {
  const frame = page.getByTestId('phone-frame');
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations().length), { timeout: 5000 })
    .toBe(0);
  const box = await frame.boundingBox();
  if (!box) throw new Error('the phone frame is not on screen');
  return box;
};

/** On-screen px per design px, at the phone's current zoom. */
const currentScale = async (page: Page) => (await frameBox(page)).width / PHONE_WIDTH;

/**
 * Waits for a locator's own (and descendant) animations to finish before anything reads
 * its geometry. `boundingBox()` waits for visibility, not for a transform to settle — a
 * tap-driven shade open plays a real 300ms `transition:fly`, and a row newly rendered
 * into a freshly-switched view (e.g. opening the archive) plays its own 150ms one.
 * Starting a drag mid-flight reads a bogus, still-animating position: exactly the bug
 * behind this helper existing, first found and fixed for the phone frame itself in
 * `display.spec.ts`'s `frameBox`. `{ subtree: true }` is what makes this reusable for a
 * row, where the animation lives on a descendant rather than the queried element itself.
 */
const waitForSettled = async (locator: Locator) => {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => locator.evaluate((el) => el.getAnimations({ subtree: true }).length), {
      timeout: 5000
    })
    .toBe(0);
};

/** Drags from `(x, startY)` to `(x, startY + onScreenDeltaY)`, spread over real steps. */
const dragVertical = async (page: Page, x: number, startY: number, onScreenDeltaY: number) => {
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, startY + onScreenDeltaY, { steps: 8 });
  await page.mouse.up();
};

/** Drags from `(startX, y)` to `(startX + onScreenDeltaX, y)`, spread over real steps. */
const dragHorizontal = async (page: Page, startX: number, y: number, onScreenDeltaX: number) => {
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + onScreenDeltaX, y, { steps: 8 });
  await page.mouse.up();
};

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
    // A name that belongs to a real conversation fixture. It used to be "Sarah Connor",
    // who existed nowhere else in the mocks — so this passed while the row's own
    // `deep_link` pointed at somebody entirely different.
    await expect(shade.getByText('Ursula (Crazy Ex)')).toBeVisible();

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

    // The toast identifies which app is talking before it says what about — `envelope.app`
    // is threaded through to `toast.show`, resolved against the manifest, and rendered as
    // a small header above the title. Scoped to the toast card itself: the home screen
    // behind it has its own "Mail" label under the launcher icon.
    const toastCard = page.locator('.pointer-events-auto', { hasText: 'You have new mail' });
    await expect(toastCard.getByText('Mail', { exact: true })).toBeVisible();
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

test.describe('Notification shade gestures', () => {
  test.beforeEach(async ({ page }) => {
    // A small viewport forces `phoneScale < 1`, the same technique `display.spec.ts`'s
    // own drag test uses — a scale-blind gesture (raw on-screen px applied 1:1) would
    // pass at the default 1280x960 viewport and still be wrong.
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('dragging down from the status bar past the threshold opens the shade', async ({ page }) => {
    const scale = await currentScale(page);
    const statusBar = page.getByRole('button', { name: 'Open notification shade' });
    const box = await statusBar.boundingBox();
    if (!box) throw new Error('status bar not on screen');

    // Comfortably past the 0.5 commit threshold — clampProgress saturates at 1, so
    // overshooting the reveal distance is a safety margin, not an error.
    await dragVertical(page, box.x + box.width / 2, box.y + box.height / 2, scale * 700);

    await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toBeVisible();
  });

  test('dragging down below the threshold springs back closed', async ({ page }) => {
    const scale = await currentScale(page);
    const statusBar = page.getByRole('button', { name: 'Open notification shade' });
    const box = await statusBar.boundingBox();
    if (!box) throw new Error('status bar not on screen');

    // Well under half of SHADE_DRAG_REVEAL_DISTANCE, and slow (8 steps over a short
    // distance) so neither the progress nor the velocity commit heuristic fires.
    await dragVertical(
      page,
      box.x + box.width / 2,
      box.y + box.height / 2,
      scale * SHADE_DRAG_REVEAL_DISTANCE * 0.15
    );

    await expect(page.getByRole('dialog', { name: 'Notification Shade' })).toBeHidden();
  });

  test('dragging up from the grab handle past the threshold closes the shade', async ({ page }) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await waitForSettled(shade);

    const scale = await currentScale(page);
    const handle = page.getByTestId('shade-grab-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('grab handle not on screen');

    await dragVertical(page, box.x + box.width / 2, box.y + box.height / 2, -scale * 700);

    await expect(shade).toBeHidden();
  });

  test('swiping a standalone notification clears it and moves it to the archive', async ({
    page
  }) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await waitForSettled(shade);

    const scale = await currentScale(page);
    const row = shade.locator('[data-gesture-drag]', {
      has: page.getByText('Developer Tools unlocked successfully.')
    });
    const box = await row.boundingBox();
    if (!box) throw new Error('row not on screen');

    await dragHorizontal(page, box.x + box.width / 2, box.y + box.height / 2, scale * 400);

    await expect(shade.getByText('Developer Tools unlocked successfully.')).toBeHidden();

    await page.getByRole('button', { name: 'Notification Archive' }).click();
    await expect(shade.getByText('Developer Tools unlocked successfully.')).toBeVisible();
  });

  test('swiping a group header clears the whole group', async ({ page }) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await waitForSettled(shade);

    // The three "messages" fixtures collapse into one group card.
    await expect(shade.getByText('3 notifications')).toBeVisible();

    const scale = await currentScale(page);
    const groupHeader = shade.locator('[data-gesture-drag]', {
      has: page.getByText('3 notifications')
    });
    const box = await groupHeader.boundingBox();
    if (!box) throw new Error('group header not on screen');

    await dragHorizontal(page, box.x + box.width / 2, box.y + box.height / 2, scale * 400);

    await expect(shade.getByText('3 notifications')).toBeHidden();
    await expect(shade.getByText('Ursula (Crazy Ex)')).toBeHidden();

    // The archive groups by app too, so the three cleared "messages" notifications
    // collapse into their own group card there — the individual "Trevor Philips" item is
    // only visible once that card is expanded, which isn't what this test is checking.
    await page.getByRole('button', { name: 'Notification Archive' }).click();
    await expect(shade.getByText('3 notifications')).toBeVisible();
    await expect(shade.getByText('Ursula (Crazy Ex)')).toBeVisible();
  });

  test('swiping a row in the archive restores it to the active list', async ({ page }) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await waitForSettled(shade);

    const scale = await currentScale(page);

    // Clear it first — via the same swipe gesture, so this test also stands as a second,
    // independent exercise of swipe-to-clear — then restore it from the archive.
    const activeRow = shade.locator('[data-gesture-drag]', {
      has: page.getByText('Developer Tools unlocked successfully.')
    });
    const activeBox = await activeRow.boundingBox();
    if (!activeBox) throw new Error('row not on screen');
    await dragHorizontal(
      page,
      activeBox.x + activeBox.width / 2,
      activeBox.y + activeBox.height / 2,
      scale * 400
    );
    await expect(shade.getByText('Developer Tools unlocked successfully.')).toBeHidden();

    await page.getByRole('button', { name: 'Notification Archive' }).click();
    const archivedRow = shade.locator('[data-gesture-drag]', {
      has: page.getByText('Developer Tools unlocked successfully.')
    });
    await waitForSettled(archivedRow);
    const archivedBox = await archivedRow.boundingBox();
    if (!archivedBox) throw new Error('archived row not on screen');
    await dragHorizontal(
      page,
      archivedBox.x + archivedBox.width / 2,
      archivedBox.y + archivedBox.height / 2,
      scale * 400
    );
    await expect(shade.getByText('Developer Tools unlocked successfully.')).toBeHidden();

    await page.getByRole('button', { name: 'Back to Active Notifications' }).click();
    await expect(shade.getByText('Developer Tools unlocked successfully.')).toBeVisible();
  });
});
