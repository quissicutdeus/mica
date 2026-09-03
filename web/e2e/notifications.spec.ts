import { test, expect, type Page, type Locator } from './support/test';
import { installAddOn } from './support/addon';
import { seedHomeGrid } from './support/homeGrid';
import { DEVICES } from '@gos/shared/devices';

/**
 * `display.ts`'s `PHONE_WIDTH` and `SHADE_DRAG_REVEAL_DISTANCE`, read from the device table
 * rather than restated. The reveal distance is the frame's height by that module's own
 * definition, and `support/homeGrid.ts` says why a spec may import the table.
 */
const PHONE_WIDTH = DEVICES.phone.frame.width;
const SHADE_DRAG_REVEAL_DISTANCE = DEVICES.phone.frame.height;

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
    // The toast is gated on `isInstalled(app)` *and* the manifest declaring
    // `notifications`. Blabber declares it and, being a bundled add-on, its manifest
    // resolves through `getManifest` even before an install (that fallback is what lets a
    // deep link render one) — so installed-ness is the only thing standing between an
    // add-on the player never installed and a toast in their face.
    //
    // Worth asserting rather than assuming: nothing else in the suite covers the negative
    // case. The data half still flows either way, deliberately; §7 says permissions are a
    // disclosure, not a sandbox.
    await pushAppEvent(page, 'blabber', '@michael mentioned you');

    const toastText = page.getByText('@michael mentioned you');
    // The timeout is deliberately far below `ToastHost`'s 4500ms default life. With the
    // default 5s expect timeout this assertion would also pass against a toast that *did*
    // appear and then expired — which is the bug it exists to catch, not a pass.
    await expect(toastText).toHaveCount(0, { timeout: 1500 });

    // ...and it is still absent after a *later* push has been processed all the way to a
    // visible toast. That second push is also this test's positive control: a
    // `pushAppEvent` that had silently stopped working could otherwise make the assertion
    // above pass for the wrong reason. `mail` is core, so it is installed and permitted.
    await pushAppEvent(page, 'mail', 'You have new mail');
    await expect(page.getByText('You have new mail')).toBeVisible();
    await expect(toastText).toHaveCount(0);
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

  test('flicking up from the shade body past the threshold closes the shade', async ({ page }) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await waitForSettled(shade);

    // The shade used to carry its own grab handle at the bottom, and this drove that.
    // It was removed (MICA-36): it sat directly on top of PhoneFrame's home bar — which
    // relabels itself to "Collapse notifications" while the shade is open — so the real,
    // labelled control could not be clicked at all, and the shade being `z-55` meant the
    // handle won the hit-test regardless of its own lower `z-10`. The close-drag it
    // carried is the same one the body already has.
    //
    // The body gesture deliberately stays out of the way until the list has nothing left
    // to reveal in the direction the pull travels, so a swipe never steals a scroll in
    // progress — `createSheetClose`'s `bodyShouldStart` in `lib/sheetDrag.ts`. Scroll to
    // the bottom first, which is where a user who had read the list would already be.
    const list = shade.locator('.overflow-y-auto').first();
    await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));

    const scale = await currentScale(page);
    const box = await shade.boundingBox();
    if (!box) throw new Error('shade not on screen');

    // From the shade's own header strip, above the list and clear of every row button —
    // `bodyShouldStart` refuses to arm on top of a `<button>`.
    await dragVertical(page, box.x + box.width / 2, box.y + 24, -scale * 700);

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

/**
 * MICA-96. Tapping a card deep-linked into the thing it was about and marked it read, and
 * that was all it did — the Active list filters on `cleared_at` and never on `read_at`, so
 * the card the player had just acted on sat there unchanged and indefinitely. The launcher
 * badge (which reads unread counts) and the shade disagreed about whether the notification
 * had been dealt with, which is the shape of the bug as reported.
 *
 * `notifications.test.ts` already pins the store's action order — read, then clear, then
 * refresh the counts. What only a real render can show is the pair of surfaces agreeing
 * afterwards, and it is a real round trip: the browser mocks hold `read_at`/`cleared_at` on
 * the fixture rows, and the archive is re-fetched from them (`getNotificationHistory`) every
 * time it is opened. So a card appearing there is evidence `clearNotifications` reached the
 * mock, not merely that a client-side store filtered it out of a list.
 */
test.describe('Tapping a notification is what handles it', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  const openShade = async (page: Page) => {
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const shade = page.getByRole('dialog', { name: 'Notification Shade' });
    await waitForSettled(shade);
    return shade;
  };

  test('tapping a standalone notification takes it out of Active and files it in the archive', async ({
    page
  }) => {
    // The settings fixture: standalone (nothing else is in its app group) and carrying the
    // bare `settings` deep link, so the tap both navigates and has to clear.
    const body = 'Developer Tools unlocked successfully.';

    // Three apps have unread notifications the status bar can resolve a manifest for —
    // settings, messages and mail. Blabber's is filtered out because it is an uninstalled
    // add-on. Captured first so the drop below is measured against a known start rather
    // than asserted in the abstract.
    const tray = page.getByTestId('status-notification-icons');
    await expect.poll(async () => tray.evaluate((el) => el.children.length)).toBe(3);

    let shade = await openShade(page);
    await expect(shade.getByText(body)).toBeVisible();

    await shade.getByText(body).click();
    // The deep link resolves, so the tap navigates into Settings and the shade closes
    // behind it — the tap is not being swallowed by the clear.
    await expect(shade).toBeHidden();

    // Step 4 of the report, verbatim: reopen the shade and look at Active. This is what
    // used to still be showing the card.
    shade = await openShade(page);
    await expect(shade.getByText(body)).toBeHidden();

    // ...and it was cleared rather than deleted. The archive is fetched fresh on every
    // open, so this is the assertion that reaches past the client store.
    await page.getByRole('button', { name: 'Notification Archive' }).click();
    await expect(shade.getByText(body)).toBeVisible();

    // The two surfaces that disagreed now agree: the status bar has dropped Settings
    // along with the card, rather than one clearing while the other holds on.
    await expect.poll(async () => tray.evaluate((el) => el.children.length)).toBe(2);
  });

  test('tapping a conversation inside a group clears that conversation and leaves the rest', async ({
    page
  }) => {
    // The second of the two handlers the fix changed. The three `messages` fixtures collapse
    // into one app group, and its rows go through `handleConversationClick` rather than
    // `handleRowClick` — which previously marked the conversation's unread items read and
    // cleared nothing, so a tapped conversation stayed in Active exactly like a tapped
    // standalone card did.
    let shade = await openShade(page);

    // The header is a disclosure, not a link: its `onclick` is `toggleGroupExpand`, and it
    // renders `group.latest.title` — so the conversation rows only exist once it is open,
    // and the name in the collapsed preview belongs to the header rather than to a row.
    //
    // Matched on the header's own accessible name, anchored at the app: the count alone is
    // not unique (Mail also holds two), and the trailing timestamp in that name ages during
    // a run, so the regex deliberately stops before it.
    const messagesGroup = (count: number) =>
      shade.getByRole('button', { name: new RegExp(`^messages ${count} notifications`) });
    await expect(messagesGroup(3)).toBeVisible();
    await messagesGroup(3).click();

    // Trevor Philips is conversation 3, and appears only as a sub-row — Ursula is the
    // group's latest and so is also in the header preview, which would match twice.
    const row = shade.getByText('Trevor Philips');
    await expect(row).toBeVisible();
    await row.click();

    // `messages?conversationId=3` resolves, so the tap navigates and the shade closes.
    await expect(shade).toBeHidden();

    shade = await openShade(page);
    // One conversation left Active, and only one: the group is down to two, and the other
    // two members are untouched. A handler that cleared the whole app group would fail here
    // just as loudly as one that cleared nothing.
    await expect(shade.getByText('Trevor Philips')).toBeHidden();
    await expect(messagesGroup(2)).toBeVisible();

    // Cleared, not deleted — and this half is read back out of the mock.
    await page.getByRole('button', { name: 'Notification Archive' }).click();
    await expect(shade.getByText('Trevor Philips')).toBeVisible();
  });
});

/**
 * MICA-103. The status bar draws one icon per app with something waiting, left to right,
 * into a run of pixels that ends at the hole-punch camera. It was capped at five — a number
 * derived without counting the `gap-1` between the icons — so the fifth icon began exactly
 * where the cutout does and was drawn half inside a hole in the screen, and anything past
 * five vanished with nothing to say it existed.
 *
 * `PhoneFrame.test.ts` covers the cap and the chip in jsdom, and its third case is a pixel
 * budget built from hand-written constants (`CLOCK_WIDTH = 62`, `CHIP_WIDTH = 24`). Those
 * constants are the part that can quietly stop being true: jsdom lays nothing out, so the
 * budget is arithmetic checking arithmetic. This measures the row Chromium actually drew
 * against the cutout Chromium actually drew, which is the only place the two can be
 * compared.
 *
 * It measures the widest row this harness can produce — five sources and a two-glyph chip —
 * not the worst case in `state/display.ts`, which is the widest clock reading beside a
 * three-glyph `+10` and clears by under four pixels. The arithmetic for that case stays in
 * the unit test; what is proved here is that the arithmetic describes the real layout.
 */
test.describe('Status bar notification icons', () => {
  test('caps the row, counts the remainder, and stays clear of the camera cutout', async ({
    page
  }) => {
    // Five sources, which is two past the cap. The fixtures supply settings, messages and
    // mail outright; installing Blabber supplies the fourth (its mention fixture is already
    // unread, and only the missing manifest was keeping it out of the row) and the Store's
    // own "installed successfully" notification is the fifth. Store has to be on the grid
    // first — the real home screen starts empty.
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
    await installAddOn(page, 'Blabber');

    const tray = page.getByTestId('status-notification-icons');
    // Three icons and the chip. Counted as direct children rather than by tag: an app icon
    // may nest whatever it likes, and what is bounded here is how many slots the row takes.
    await expect.poll(async () => tray.evaluate((el) => el.children.length)).toBe(4);
    // The remainder is reported rather than silently dropped, which was the worse half of
    // the original bug — a cap with nowhere for the overflow to be.
    await expect(tray).toHaveText('+2');

    // Now the geometry, in the phone's own design pixels: the frame is drawn at whatever
    // scale the window allows (`display.ts`), so on-screen numbers are meaningless until
    // they are divided back out. Both boxes come from the same rendered frame, so the
    // comparison itself would hold either way — expressing it in design px is what lets
    // the numbers below be read against `state/display.ts`'s derivation.
    const frame = await frameBox(page);
    const scale = frame.width / PHONE_WIDTH;
    const trayBox = await tray.boundingBox();
    const cutoutBox = await page.getByTestId('camera-cutout').boundingBox();
    if (!trayBox || !cutoutBox) throw new Error('the status bar is not on screen');

    const rowEnd = (trayBox.x + trayBox.width - frame.x) / scale;
    const cutoutStart = (cutoutBox.x - frame.x) / scale;

    // The assertion that fails at the old cap of five: five icons end at 188px against a
    // cutout starting at 187.5px. At three the row ends around 174px.
    expect(rowEnd, `the notification row runs into the camera cutout`).toBeLessThan(cutoutStart);

    // And the cutout really is where the derivation says it is — a cutout that had moved
    // would make the assertion above pass for a reason that has nothing to do with the cap.
    expect(cutoutStart).toBeCloseTo(PHONE_WIDTH / 2 - 12, 0);
  });
});
